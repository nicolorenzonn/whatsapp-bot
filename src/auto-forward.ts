// Auto-reenvío: replica mensajes entre targets según reglas en wsp_forwards.
//
// Dos flujos:
//
// A) FROMME (grupos/canales propios): cuando el user postea en un target
//    del que es admin (typically canal → comunidad cuando la comunidad se
//    llena), el mensaje viene marcado fromMe=true en messages.upsert.
//    Regla dispara.
//
// B) NEWSLETTER-TERCERO (canal que sólo seguimos): en canales de WhatsApp
//    (JID @newsletter) solo el owner postea. Si el bot sigue un canal ajeno,
//    los mensajes llegan con fromMe=false porque los emite otra cuenta.
//    Aceptamos igual cuando el source de la regla es un canal (@newsletter).
//
// Dos modos de re-envío (por columna wsp_forwards.mode):
//
//   - literal: sock.sendMessage(dst, { forward: msg }) → WhatsApp marca
//     "Reenviado". Soporta texto + imagen + video + audio + sticker + doc.
//   - ia_rewrite: extraemos texto, lo pasamos por Claude (con ia_prompt
//     custom o default), y publicamos como mensaje nativo. Si hay media
//     con caption, reescribimos SOLO el caption; si es media sin caption,
//     caemos al forward literal (nada que reescribir).
//
// Anti-loop: si un destino también es source de otra regla, podríamos
// tener loop. Por ahora confiamos en que el user no arme ciclos.

import type { WASocket, proto } from "baileys";
import { sb } from "./supabase.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { reescribirParaForward } from "./forward-rewriter.js";
import type { ForwardMode, WspForward, WspTarget } from "./types.js";

// Abstracción sobre el origen del mensaje. Permite que auto-forward acepte
// tanto Baileys (WhatsApp) como GramJS (Telegram) sin duplicar el pipeline.
// - WhatsApp: sourceType='whatsapp', baileysMsg presente (para literal mode).
// - Telegram: sourceType='telegram', baileysMsg ausente (literal se manda
//   como texto plano — no hay "forward flag" equivalente cross-plataforma).
interface IncomingMessage {
  sourceType: "whatsapp" | "telegram";
  sourceJid: string;
  text: string | null;
  baileysMsg?: proto.IWebMessageInfo;
}

// State in-memory. Indexamos forwards por source_jid para lookup O(1)
// en cada mensaje. Los targets los guardamos aparte para mapear jid↔id.
interface Rule {
  id: number;
  sourceJid: string;
  destJid: string;
  destNombre: string;
  destId: number;
  sourceNombre: string;
  delayMin: number;
  delayMax: number;
  mode: ForwardMode;
  iaPrompt: string | null;
  destSuffix: string | null;
}

let rulesBySourceJid = new Map<string, Rule[]>();
let targetsById = new Map<number, WspTarget>();

function jitterMs(min: number, max: number): number {
  const span = Math.max(0, max - min);
  const extra = Math.floor(Math.random() * (span + 1));
  return (min + extra) * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Recarga el cache desde la DB. Se llama al boot y cada vez que Realtime
// notifica un cambio en wsp_forwards o wsp_targets.
async function reloadRules(): Promise<void> {
  const { data: forwards, error: fErr } = await sb
    .from("wsp_forwards")
    .select("*")
    .eq("user_id", config.userId)
    .eq("enabled", 1);

  if (fErr) {
    log.error("auto-forward: error leyendo forwards:", fErr.message);
    return;
  }

  const { data: targets, error: tErr } = await sb
    .from("wsp_targets")
    .select("*")
    .eq("user_id", config.userId);

  if (tErr) {
    log.error("auto-forward: error leyendo targets:", tErr.message);
    return;
  }

  targetsById = new Map((targets ?? []).map((t) => [t.id, t as WspTarget]));

  const newMap = new Map<string, Rule[]>();
  let validRules = 0;
  for (const f of (forwards ?? []) as WspForward[]) {
    const src = targetsById.get(f.source_target_id);
    const dst = targetsById.get(f.dest_target_id);
    if (!src || !dst) {
      log.warn(
        `auto-forward: regla ${f.id} con target faltante (src=${f.source_target_id}, dst=${f.dest_target_id}) — skip`,
      );
      continue;
    }
    const rule: Rule = {
      id: f.id,
      sourceJid: src.jid,
      destJid: dst.jid,
      destNombre: dst.nombre,
      destId: dst.id,
      sourceNombre: src.nombre,
      delayMin: f.delay_min_seconds,
      delayMax: f.delay_max_seconds,
      mode: f.mode ?? "literal",
      iaPrompt: f.ia_prompt ?? null,
      destSuffix: f.dest_suffix ?? null,
    };
    const arr = newMap.get(src.jid) ?? [];
    arr.push(rule);
    newMap.set(src.jid, arr);
    validRules++;
  }
  rulesBySourceJid = newMap;
  log.info(`auto-forward: ${validRules} regla(s) activa(s) cargadas`);
}

// Suscripción Realtime — recargamos cache cuando cambia algo.
function subscribeRealtime(): void {
  sb.channel("wsp-forwards-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "wsp_forwards", filter: `user_id=eq.${config.userId}` },
      () => {
        log.debug("auto-forward: cambio en wsp_forwards detectado, recargando");
        void reloadRules();
      },
    )
    .subscribe((status) => {
      log.debug(`auto-forward: realtime channel status: ${status}`);
    });
}

// Procesa una notificación de mensaje nuevo. Si matchea una regla, agenda
// el reenvío (no awaitea — corre en background con el jitter).
async function handleMessage(
  sock: WASocket,
  msg: proto.IWebMessageInfo,
): Promise<void> {
  // Filtrar updates "vacíos" (read receipts, etc).
  if (!msg.message) return;

  const fromJid = msg.key.remoteJid;
  if (!fromJid) return;

  const rules = rulesBySourceJid.get(fromJid);
  if (!rules || rules.length === 0) return;

  // Regla de aceptación:
  //   - fromMe=true → siempre aceptamos (usuario posteó en un target propio)
  //   - fromMe=false → aceptamos SOLO si el source es un @newsletter (canal
  //     que seguimos). En canales solo el owner postea, así que el mensaje
  //     es del canal fuente autorizado. En grupos ajenos con fromMe=false
  //     descartamos — no queremos reenviar mensajes de otras personas en
  //     grupos donde participamos sin ser owners.
  const isFromNewsletterCanal = fromJid.endsWith("@newsletter");
  if (!msg.key.fromMe && !isFromNewsletterCanal) return;

  const incoming: IncomingMessage = {
    sourceType: "whatsapp",
    sourceJid: fromJid,
    text: extraerTexto(msg),
    baileysMsg: msg,
  };

  for (const rule of rules) {
    // Fire and forget — cada regla corre en su propio scheduled forward.
    void runForward(sock, rule, incoming).catch((e) =>
      log.error(`auto-forward: regla ${rule.id} falló:`, e instanceof Error ? e.message : e),
    );
  }
}

// Handler para mensajes que vienen desde Telegram (via telegram-client.ts).
// Requiere que el WhatsApp sock esté vivo para poder publicar en el destino
// (los destinos siguen siendo canales/grupos de WhatsApp por ahora).
export function handleTelegramMessage(
  getSock: () => WASocket | null,
  evt: { sourceJid: string; sourceName: string; text: string | null },
): void {
  const rules = rulesBySourceJid.get(evt.sourceJid);
  if (!rules || rules.length === 0) return;

  const sock = getSock();
  if (!sock) {
    log.warn(
      `auto-forward: mensaje Telegram de ${evt.sourceName} llegó pero WhatsApp está offline — skip`,
    );
    return;
  }

  const incoming: IncomingMessage = {
    sourceType: "telegram",
    sourceJid: evt.sourceJid,
    text: evt.text,
    // baileysMsg queda undefined — literal mode desde TG cae a text send
  };

  for (const rule of rules) {
    void runForward(sock, rule, incoming).catch((e) =>
      log.error(`auto-forward: regla ${rule.id} (TG) falló:`, e instanceof Error ? e.message : e),
    );
  }
}

// Extrae texto plano de un mensaje Baileys. Cubre: text puro, extended text
// (con menciones/links), image caption, video caption, document caption.
// Retorna null si no hay texto útil para reescribir.
function extraerTexto(msg: proto.IWebMessageInfo): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    null
  );
}

// Construye un mensaje de imagen/video/documento con un caption nuevo,
// reusando la media del original. Baileys re-sube la media automáticamente.
function reBuildMediaWithNewCaption(
  msg: proto.IWebMessageInfo,
  newCaption: string,
): Record<string, unknown> | null {
  const m = msg.message;
  if (!m) return null;
  if (m.imageMessage) {
    return { image: m.imageMessage, caption: newCaption };
  }
  if (m.videoMessage) {
    return { video: m.videoMessage, caption: newCaption };
  }
  if (m.documentMessage) {
    return { document: m.documentMessage, caption: newCaption };
  }
  return null;
}

async function runForward(
  sock: WASocket,
  rule: Rule,
  incoming: IncomingMessage,
): Promise<void> {
  const delayMs = jitterMs(rule.delayMin, rule.delayMax);
  log.info(
    `auto-forward: regla ${rule.id} [${rule.mode}] [src:${incoming.sourceType}] "${rule.sourceNombre}" → "${rule.destNombre}" en ${(delayMs / 1000).toFixed(1)}s`,
  );
  await sleep(delayMs);

  try {
    if (rule.mode === "ia_rewrite") {
      // Modo IA: solo publicamos si hay texto útil que reescribir.
      // Casos:
      //   - Sin texto (foto sola, sticker, audio) → SKIP.
      //   - Con texto: Claude decide. Si devuelve "[SKIP]" no publicamos.
      //   - Texto útil: reescribe + append dest_suffix.
      const original = incoming.text;
      if (!original || original.trim().length === 0) {
        log.info(
          `auto-forward: regla ${rule.id} sin texto — skip`,
        );
        return;
      }
      const reescrito = await reescribirParaForward(
        rule.id,
        original,
        rule.iaPrompt,
      );
      const normalizado = reescrito.trim().toUpperCase();
      if (normalizado === "[SKIP]" || normalizado.startsWith("[SKIP]")) {
        log.info(
          `auto-forward: regla ${rule.id} Claude devolvió SKIP — no publico`,
        );
        return;
      }
      const finalText = rule.destSuffix
        ? `${reescrito.trim()}\n\n${rule.destSuffix.trim()}`
        : reescrito;
      await sock.sendMessage(rule.destJid, { text: finalText });
    } else {
      // Modo literal:
      //   - Origen WhatsApp: forward tal cual (etiqueta "Reenviado" preservada).
      //   - Origen Telegram: solo tenemos texto; lo mandamos como mensaje
      //     nuevo. No hay forward-flag cross-plataforma en WhatsApp.
      if (incoming.baileysMsg) {
        await sock.sendMessage(rule.destJid, { forward: incoming.baileysMsg });
      } else if (incoming.text) {
        await sock.sendMessage(rule.destJid, { text: incoming.text });
      } else {
        log.info(
          `auto-forward: regla ${rule.id} literal sin contenido reenviable — skip`,
        );
        return;
      }
    }
    log.info(`auto-forward: regla ${rule.id} → ${rule.destNombre} ✓`);

    // Actualizar contador en DB — best effort, no abortamos si falla.
    await sb
      .from("wsp_forwards")
      .update({
        last_forwarded_at: new Date().toISOString(),
        total_forwarded: 0, // se sobreescribe abajo con increment server-side
      })
      .eq("id", rule.id);
    // Increment atómico via RPC sería más limpio, pero por ahora hacemos
    // un select+update simple. Race conditions son aceptables — es solo
    // un contador display.
    const { data: cur } = await sb
      .from("wsp_forwards")
      .select("total_forwarded")
      .eq("id", rule.id)
      .single();
    if (cur) {
      await sb
        .from("wsp_forwards")
        .update({ total_forwarded: (cur.total_forwarded ?? 0) + 1 })
        .eq("id", rule.id);
    }
  } catch (e) {
    log.error(
      `auto-forward: sendMessage falló para regla ${rule.id} (${rule.destNombre}):`,
      e instanceof Error ? e.message : e,
    );
  }
}

// API pública: arrancar el sistema. Lee reglas, se suscribe a realtime,
// y engancha el handler de mensajes al sock pasado.
export async function startAutoForward(sock: WASocket): Promise<void> {
  await reloadRules();
  subscribeRealtime();
  sock.ev.on("messages.upsert", async (ev) => {
    if (ev.type !== "notify") return; // ignorar history backfill
    for (const msg of ev.messages) {
      void handleMessage(sock, msg);
    }
  });
  log.info("auto-forward: handler de mensajes activo");
}

// Llamado desde el daemon cuando se reconecta — re-engancha handler al
// nuevo sock pero NO re-suscribe a realtime (ya está vivo).
export function rebindAutoForward(sock: WASocket): void {
  sock.ev.on("messages.upsert", async (ev) => {
    if (ev.type !== "notify") return;
    for (const msg of ev.messages) {
      void handleMessage(sock, msg);
    }
  });
}
