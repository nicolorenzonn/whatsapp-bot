// Auto-reenvío: cuando el user postea en un canal/grupo, el bot replica
// el mismo mensaje a otro target (típicamente canal → comunidad cuando
// la comunidad se llena y no podés sumar gente nueva).
//
// Cómo funciona:
//   1. Cargamos reglas desde wsp_forwards al boot + las recargamos por
//      Supabase Realtime cuando hay INSERT/UPDATE/DELETE.
//   2. Escuchamos sock.ev "messages.upsert" type="notify" (live, no history).
//   3. Para cada mensaje fromMe, buscamos si su remoteJid matchea alguna
//      regla activa. Si sí, esperamos jitter [min, max]s y reenviamos.
//   4. Usamos { forward: msg } para que WhatsApp marque "Reenviado".
//      Eso soporta texto + imagen + video + audio + sticker + doc — Baileys
//      re-sube el media automáticamente.
//
// Anti-loop: si el dest target también es source de otra regla, podríamos
// tener un loop. Por ahora confiamos en que el user no arme ciclos
// (la UI no debería ofrecerlos pero no lo validamos en bot).

import type { WASocket, proto } from "baileys";
import { sb } from "./supabase.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { WspForward, WspTarget } from "./types.js";

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
  // Solo mensajes que escribimos NOSOTROS. No queremos reenviar lo que
  // postean otros admins del canal por su cuenta.
  if (!msg.key.fromMe) return;
  // Filtrar updates "vacíos" (read receipts, etc).
  if (!msg.message) return;

  const fromJid = msg.key.remoteJid;
  if (!fromJid) return;

  const rules = rulesBySourceJid.get(fromJid);
  if (!rules || rules.length === 0) return;

  for (const rule of rules) {
    // Fire and forget — cada regla corre en su propio scheduled forward.
    void runForward(sock, rule, msg).catch((e) =>
      log.error(`auto-forward: regla ${rule.id} falló:`, e instanceof Error ? e.message : e),
    );
  }
}

async function runForward(
  sock: WASocket,
  rule: Rule,
  msg: proto.IWebMessageInfo,
): Promise<void> {
  const delayMs = jitterMs(rule.delayMin, rule.delayMax);
  log.info(
    `auto-forward: regla ${rule.id} "${rule.sourceNombre}" → "${rule.destNombre}" en ${(delayMs / 1000).toFixed(1)}s`,
  );
  await sleep(delayMs);

  try {
    await sock.sendMessage(rule.destJid, { forward: msg });
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
