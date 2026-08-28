// DM Handler: escucha mensajes directos (jid @s.whatsapp.net) y persiste
// las conversaciones en wsp_conversations + wsp_conversation_messages.
//
// Flujo por mensaje entrante:
//   1. Filtrar: solo DMs (no grupos/canales — esos van por auto-forward.ts).
//   2. Ignorar fromMe (para no procesar mensajes propios como si fueran del player).
//   3. Lookup del player por teléfono → contexto + segment.
//   4. Upsert de conversation (crea si es nueva, actualiza last_inbound_at).
//   5. Insert del mensaje entrante en wsp_conversation_messages.
//   6. Si ia_mode != 'off' → llamar a setter-brain para generar draft.
//   7. Persistir el draft con ia_draft=1 (modo shadow) O enviarlo si mode='auto'.
//
// Modo 'auto' NO está habilitado por default en esta primera versión — el
// bot solo genera drafts en modo shadow. El user aprueba desde la UI.
// Cuando estemos cómodos con la calidad de los drafts, activamos auto
// por conversación individual.

import type { WASocket, proto } from "baileys";
import { sb } from "./supabase.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { lookupPlayerByPhone, phoneFromJid, isVipSegment } from "./player-lookup.js";
import { generarDraftRespuesta, type ConversationTurn } from "./setter-brain.js";

const SETTER_ENABLED = process.env.SETTER_ENABLED === "1";

// Extrae texto plano de un mensaje Baileys (reusamos la lógica de auto-forward).
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

function detectarMediaTipo(msg: proto.IWebMessageInfo): string | null {
  const m = msg.message;
  if (!m) return null;
  if (m.imageMessage) return "image";
  if (m.videoMessage) return "video";
  if (m.audioMessage) return "audio";
  if (m.documentMessage) return "document";
  if (m.stickerMessage) return "sticker";
  return null;
}

async function upsertConversation(params: {
  jid: string;
  telefono: string;
  jugadorId: string | null;
  jugadorNombre: string | null;
  afiliado: string | null;
}): Promise<{ id: number; ia_mode: string; status: string } | null> {
  // Buscamos primero por (user_id, jid). Si existe, devolvemos el id.
  const { data: existing, error: selErr } = await sb
    .from("wsp_conversations")
    .select("id, ia_mode, status")
    .eq("user_id", config.userId)
    .eq("jid", params.jid)
    .maybeSingle();

  if (selErr) {
    log.error("dm-handler: error consultando conversation:", selErr.message);
    return null;
  }

  if (existing) {
    // Actualizamos snapshot + last_inbound_at. unread_count se incrementa con
    // un patch simple (leemos + suma) — no es perfecto ante concurrencia pero
    // los DMs de un player individual son secuenciales, no hay race real.
    const patch: Record<string, unknown> = {
      last_inbound_at: new Date().toISOString(),
    };
    if (params.jugadorId) patch.jugador_id = params.jugadorId;
    if (params.jugadorNombre) patch.jugador_nombre = params.jugadorNombre;
    if (params.afiliado) patch.afiliado = params.afiliado;
    await sb.from("wsp_conversations").update(patch).eq("id", existing.id);
    return existing;
  }

  // No existe — creamos.
  const { data: created, error: insErr } = await sb
    .from("wsp_conversations")
    .insert({
      user_id: config.userId,
      jid: params.jid,
      telefono: params.telefono,
      jugador_id: params.jugadorId,
      jugador_nombre: params.jugadorNombre,
      afiliado: params.afiliado,
      last_inbound_at: new Date().toISOString(),
      unread_count: 1,
      // 2026-08-27: default AUTO — la IA responde sola desde el primer
      // mensaje respetando la filosofía cero-push del setter-brain.
      // Solo escala a humano si action="escalate" o si el user cambia
      // manualmente ia_mode desde la UI del CRM.
      ia_mode: "auto",
      status: "active",
    })
    .select("id, ia_mode, status")
    .single();

  if (insErr) {
    log.error("dm-handler: error creando conversation:", insErr.message);
    return null;
  }
  return created;
}

async function loadHistory(conversationId: number, limit = 10): Promise<ConversationTurn[]> {
  const { data } = await sb
    .from("wsp_conversation_messages")
    .select("direction, texto, media_tipo, created_at")
    .eq("conversation_id", conversationId)
    .eq("ia_draft", 0) // ignoramos drafts no enviados en el histórico
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as ConversationTurn[]).reverse();
}

/**
 * Entry point: procesa un mensaje entrante Baileys.
 * Solo actúa sobre DMs (jid @s.whatsapp.net). Otros JIDs se ignoran acá
 * (los maneja auto-forward.ts).
 *
 * @param sock socket Baileys — necesario para el auto-send cuando
 *             conv.ia_mode='auto'. Si es null, solo guarda drafts (modo
 *             shadow legacy).
 */
export async function handleDM(msg: proto.IWebMessageInfo, sock: WASocket | null = null): Promise<void> {
  const jid = msg.key.remoteJid;
  if (!jid || !jid.endsWith("@s.whatsapp.net")) return;

  // Ignoramos mensajes propios (fromMe) — el user puede estar respondiendo
  // desde su cel; no queremos procesarlos como si fueran del player.
  if (msg.key.fromMe) return;

  // Filtrar updates vacíos (read receipts, delivery, typing).
  if (!msg.message) return;

  const telefono = phoneFromJid(jid);
  if (!telefono) return;

  const texto = extraerTexto(msg);
  const mediaTipo = detectarMediaTipo(msg);

  // Skip mensajes vacíos totales (ni texto ni media reconocible).
  if (!texto && !mediaTipo) return;

  try {
    // 1. Lookup player
    const lookup = await lookupPlayerByPhone(telefono);
    const isVip = isVipSegment(lookup.segment);

    log.info(
      `dm-handler: DM de ${telefono} (${lookup.segment}) — ${
        lookup.player?.nombre ?? "sin nombre"
      }: "${(texto ?? "[" + (mediaTipo ?? "?") + "]").slice(0, 80)}"`,
    );

    // 2. Upsert conversation
    const conv = await upsertConversation({
      jid,
      telefono,
      jugadorId: lookup.player?.jugador_id ?? null,
      jugadorNombre: lookup.player?.nombre ?? null,
      afiliado: lookup.player?.afiliado ?? null,
    });
    if (!conv) return;

    // 3. Insert mensaje entrante
    await sb.from("wsp_conversation_messages").insert({
      user_id: config.userId,
      conversation_id: conv.id,
      direction: "in",
      wsp_message_id: msg.key.id ?? null,
      texto,
      media_tipo: mediaTipo,
    });

    // 4. IA: solo si setter está habilitado global Y la conversación no está
    // en modo off. Además: por ahora solo generamos draft para VIPs — a los
    // no_vip y desconocidos los dejamos para escalación manual.
    if (!SETTER_ENABLED) return;
    if (conv.ia_mode === "off") return;
    if (!isVip) {
      log.debug(`dm-handler: ${telefono} no es VIP (${lookup.segment}), skip IA`);
      return;
    }

    // Load history para dar contexto a Claude
    const history = await loadHistory(conv.id, 10);

    const draft = await generarDraftRespuesta({
      player: lookup.player,
      segment: lookup.segment,
      history,
      lastInboundText: texto ?? "",
    });

    log.info(
      `dm-handler: draft IA para ${telefono} → action=${draft.action} confidence=${draft.confidence}`,
    );

    // 5. Persistir el draft o escalar
    if (draft.action === "reply" && draft.text) {
      // Threshold de confianza mínima para auto-send. Debajo de esto,
      // queda como draft para revisión humana aunque conv esté en 'auto'.
      const MIN_CONFIDENCE = 0.6;
      const puedeAutoSend =
        conv.ia_mode === "auto" &&
        sock !== null &&
        draft.confidence >= MIN_CONFIDENCE;

      if (puedeAutoSend) {
        try {
          const res = await sock!.sendMessage(jid, { text: draft.text });
          const wspMsgId = res?.key?.id ?? null;
          await sb.from("wsp_conversation_messages").insert({
            user_id: config.userId,
            conversation_id: conv.id,
            direction: "out",
            wsp_message_id: wspMsgId,
            texto: draft.text,
            ia_draft: 0,           // fue enviado por IA, no queda como draft
            ia_reasoning: draft.reasoning,
            ia_confidence: draft.confidence,
          });
          await sb
            .from("wsp_conversations")
            .update({ last_outbound_at: new Date().toISOString() })
            .eq("id", conv.id);
          log.info(
            `dm-handler: AUTO-SEND a ${telefono} — confidence=${draft.confidence.toFixed(2)}`,
          );
        } catch (e) {
          log.error(
            `dm-handler: auto-send fallo, guardo como draft:`,
            e instanceof Error ? e.message : e,
          );
          // Fallback: guardar como draft para revisión humana
          await sb.from("wsp_conversation_messages").insert({
            user_id: config.userId,
            conversation_id: conv.id,
            direction: "out",
            texto: draft.text,
            ia_draft: 1,
            ia_reasoning: `AUTO-SEND FAILED: ${draft.reasoning}`,
            ia_confidence: draft.confidence,
          });
        }
      } else {
        // Modo shadow — o confidence bajo. Guarda como draft.
        await sb.from("wsp_conversation_messages").insert({
          user_id: config.userId,
          conversation_id: conv.id,
          direction: "out",
          texto: draft.text,
          ia_draft: 1,
          ia_reasoning: draft.reasoning,
          ia_confidence: draft.confidence,
        });
        if (conv.ia_mode === "auto" && draft.confidence < MIN_CONFIDENCE) {
          log.info(
            `dm-handler: confidence baja (${draft.confidence.toFixed(2)} < ${MIN_CONFIDENCE}), quedó como draft para revisión`,
          );
        }
      }
    } else if (draft.action === "escalate") {
      await sb
        .from("wsp_conversations")
        .update({
          status: "escalated",
          notas: `IA escaló: ${draft.reasoning.slice(0, 500)}`,
        })
        .eq("id", conv.id);
    }
    // action === 'skip' → no hacemos nada, el mensaje entrante ya quedó registrado.
  } catch (e) {
    log.error(
      "dm-handler: error procesando DM:",
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * Engancha el handler al socket de Baileys. Se llama desde daemon.ts al
 * conectar (y en cada re-conexión).
 */
export function bindDMHandler(sock: WASocket): void {
  sock.ev.on("messages.upsert", async (ev) => {
    // DEBUG temporal: loguear TODO lo que llega para diagnosticar por qué
    // no procesamos DMs entrantes. Sacar después.
    log.info(
      `dm-handler[DEBUG]: messages.upsert type="${ev.type}" msgs=${ev.messages.length}`,
    );
    for (const msg of ev.messages) {
      log.info(
        `dm-handler[DEBUG]: msg jid=${msg.key.remoteJid ?? "null"} fromMe=${msg.key.fromMe} id=${msg.key.id ?? "null"} hasMessage=${!!msg.message} keys=${Object.keys(msg.message ?? {}).join(",")}`,
      );
    }
    if (ev.type !== "notify") {
      log.info(`dm-handler[DEBUG]: skip por type != notify (type=${ev.type})`);
      return;
    }
    for (const msg of ev.messages) {
      // Pasamos el sock al handler para que pueda hacer auto-send si la
      // conversación está en modo 'auto' y la IA responde con confidence
      // suficiente. Si el sock desaparece (reconexión), el handler cae
      // gracefully a modo draft para no perder el mensaje.
      void handleDM(msg, sock);
    }
  });
  log.info(
    `dm-handler: activo (setter ${SETTER_ENABLED ? "ENABLED" : "DISABLED"} vía SETTER_ENABLED, auto-send habilitado para conversaciones ia_mode='auto')`,
  );
}
