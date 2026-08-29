// Cerebro IA del setter casino: recibe contexto de conversación + perfil
// del player y devuelve una propuesta de respuesta.
//
// Modo shadow por default — el output NO se envía, solo se persiste en
// wsp_conversation_messages con ia_draft=1. El user aprueba en la UI.
//
// El prompt es CONSERVADOR en v1: si Claude no está seguro, devuelve
// [SKIP] y el thread queda como 'escalated' esperando intervención humana.
// Vamos a afinar el prompt con conversaciones reales antes de habilitar
// modo auto.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { PlayerProfile, PlayerSegment } from "./player-lookup.js";

const anthropic = config.anthropicKey
  ? new Anthropic({ apiKey: config.anthropicKey })
  : null;

export interface ConversationTurn {
  direction: "in" | "out";
  texto: string | null;
  media_tipo?: string | null;
  created_at: string;
}

export interface DraftInput {
  player: PlayerProfile | null;
  segment: PlayerSegment;
  history: ConversationTurn[]; // últimos N mensajes del thread, cronológicos
  lastInboundText: string;      // el último mensaje entrante (el que hay que responder)
}

export interface DraftOutput {
  action: "reply" | "skip" | "escalate";
  // reply: proponer respuesta (texto en output.text)
  // skip: no responder — mensaje trivial (emoji suelto, imagen sin caption)
  // escalate: pedir intervención humana — tema fuera del scope del bot
  text: string | null;
  reasoning: string;
  confidence: number; // 0..1
}

const SYSTEM_PROMPT = `Sos "Nico", ASISTENTE VIP PERSONAL del programa de Sportsbet Argentina. \
No sos amigo casual — sos un profesional del equipo VIP que atiende clientes premium por WhatsApp con canal dedicado.

REGLAS DE FORMA:
• Español rioplatense, voseo (tenés / querés / mirá).
• MÁXIMO 2-3 oraciones por mensaje. Cortito. Sin sermones ni corporativismo.
• VARIÁ SIEMPRE la estructura entre mensajes — WhatsApp detecta bots por respuestas idénticas. Cambiá saludo, orden, cierre.
• PROHIBIDO "boludo", "todo tranqui por casa", "🎮" y emojis gamer (eso es amigo, no VIP).
• Emojis: 0-1 por mensaje, y solo si encaja profesionalmente (ej: 👋 al saludar, ✅ al confirmar). Cero emojis "de fiesta".

REGLAS DURAS DE CONTENIDO (INVIOLABLES — si dudás, escalás):
1. NUNCA prometas ganancias ni "vas a ganar" — ni implícito ni explícito.
2. NUNCA compartas datos de otros jugadores.
3. NUNCA inventes bonos, promos, cuotas ni códigos. Si te preguntan por
   una promo específica que no tenés en el contexto, escalás.
4. Si el player menciona QUERER RETIRAR, PROBLEMA DE DEPÓSITO, RECLAMO
   FORMAL o QUEJA GRAVE → escalás (no intentes resolver).
5. Si detectás SEÑALES DE JUEGO PROBLEMÁTICO (frases como "no puedo
   parar", "perdí todo", "necesito recuperar", "estoy en bancarrota"),
   escalás con máxima prioridad — NO respondas con oferta ni consejo,
   solo empatía breve + escalación.
6. Si el player pide su balance actual → decile que lo vea directo en la
   app del casino (no tenés acceso en vivo).

DECISIÓN — tenés 3 acciones posibles, devolvés JSON:

{
  "action": "reply" | "skip" | "escalate",
  "text": "<respuesta o null>",
  "reasoning": "<1-2 frases explicando la decisión>",
  "confidence": 0.0-1.0
}

• "reply": tenés respuesta clara + segura. Poné el texto en "text".
• "skip": el mensaje no requiere respuesta (emoji suelto, "ok", sticker,
  audio no transcribible). "text" = null.
• "escalate": alguna regla dura o zona gris → dejás que Nico responda.
  "text" = null. Explicá en "reasoning" por qué escalás.

Si tu confidence < 0.7 → escalás.

CONTEXTO DEL PLAYER (te lo dan en cada llamada — usalo con criterio):
• Nombre (para tratar por nombre si aporta)
• Segmento: vip_activo (depósito últimos 30d), vip_dormido (30-90d),
  vip_frio (90+ o nunca), no_vip (afiliado distinto — igual respondés
  con cortesía pero NO ofrezcas promos exclusivas VIP), desconocido
  (no matcheás con ningún jugador — sé especialmente cauto).
• LTV apostado histórico (número orientativo del valor del cliente)
• Días desde último depósito / último login

Devolvés SOLO el JSON, sin markdown fences, sin texto adicional.`;

function contextoPlayer(input: DraftInput): string {
  const p = input.player;
  const parts: string[] = [
    `Segmento: ${input.segment}`,
  ];
  if (p) {
    parts.push(`Nombre: ${p.nombre ?? "(sin nombre)"}`);
    parts.push(`LTV apostado histórico: ${Math.round(p.ltv_apostado)}`);
    if (p.dias_ultimo_deposito !== null) {
      parts.push(`Días desde último depósito: ${p.dias_ultimo_deposito}`);
    } else {
      parts.push(`Nunca depositó`);
    }
    if (p.dias_ultimo_login !== null) {
      parts.push(`Días desde último login: ${p.dias_ultimo_login}`);
    }
    parts.push(`Afiliado: ${p.afiliado}`);
  } else {
    parts.push(`(no matchea con ningún jugador en la DB)`);
  }
  return parts.join(" | ");
}

function historyPrompt(history: ConversationTurn[]): string {
  if (history.length === 0) return "(sin historial previo — primer mensaje del thread)";
  return history
    .slice(-10) // últimos 10 turnos
    .map((t) => {
      const rol = t.direction === "in" ? "PLAYER" : "NICO (o bot previo)";
      const txt = t.texto ?? `[${t.media_tipo ?? "sin texto"}]`;
      return `${rol}: ${txt}`;
    })
    .join("\n");
}

/**
 * Genera propuesta de respuesta. NUNCA envía nada — devuelve el draft
 * al caller que decide (persist, escalate, auto-send según config).
 * Si Anthropic no está configurado, devuelve action=escalate para no
 * bloquear la captura.
 */
export async function generarDraftRespuesta(
  input: DraftInput,
): Promise<DraftOutput> {
  if (!anthropic) {
    return {
      action: "escalate",
      text: null,
      reasoning: "ANTHROPIC_API_KEY no configurada — setter deshabilitado, escalo a humano",
      confidence: 0,
    };
  }

  const userMessage = [
    "CONTEXTO DEL PLAYER:",
    contextoPlayer(input),
    "",
    "HISTORIAL DEL THREAD (cronológico, últimos 10):",
    historyPrompt(input.history),
    "",
    "MENSAJE ENTRANTE A RESPONDER:",
    input.lastInboundText,
  ].join("\n");

  try {
    const res = await anthropic.messages.create({
      model: config.anthropicModel,
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    const block = res.content[0];
    const raw = block?.type === "text" ? block.text.trim() : "";

    // Parseamos el JSON esperado. Si Claude devolvió algo raro, escalamos.
    let parsed: DraftOutput;
    try {
      // Tolerancia: si Claude puso markdown fences por error, los pelamos.
      const cleaned = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
      parsed = JSON.parse(cleaned) as DraftOutput;
    } catch (e) {
      log.warn(
        "setter-brain: Claude devolvió JSON inválido, escalando:",
        e instanceof Error ? e.message : e,
      );
      return {
        action: "escalate",
        text: null,
        reasoning: `Claude devolvió JSON inválido: ${raw.slice(0, 200)}`,
        confidence: 0,
      };
    }

    // Validación mínima del shape
    if (
      !parsed ||
      !["reply", "skip", "escalate"].includes(parsed.action) ||
      typeof parsed.reasoning !== "string"
    ) {
      return {
        action: "escalate",
        text: null,
        reasoning: `Claude devolvió shape inválido: ${JSON.stringify(parsed).slice(0, 200)}`,
        confidence: 0,
      };
    }

    // Enforcement del threshold de confianza — regla del prompt pero
    // la reforzamos también acá por si Claude no la respeta.
    if (parsed.action === "reply" && (parsed.confidence ?? 0) < 0.7) {
      return {
        ...parsed,
        action: "escalate",
        text: null,
        reasoning: `Draft original (baja confianza ${parsed.confidence}): ${parsed.reasoning}`,
      };
    }

    return parsed;
  } catch (e) {
    log.error("setter-brain: Claude falló:", e instanceof Error ? e.message : e);
    return {
      action: "escalate",
      text: null,
      reasoning: `Anthropic call falló: ${e instanceof Error ? e.message : e}`,
      confidence: 0,
    };
  }
}
