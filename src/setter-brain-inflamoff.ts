// Cerebro IA del setter Inflamoff — atención + ventas de cosmética.
// Misma interface que setter-brain.ts (casino) para que dm-handler pueda
// elegir cuál usar según config.botMode.
//
// Contexto: Inflamoff es marca argentina de cosmética natural / skincare.
// Productos actuales (agosto 2026): Inflamoff x60, CeluOFF x60, BronceON x60,
// CandiOFF x60 (todas cápsulas 60 unidades).
//
// Código descuento vigente (24hs desde HOY):
//   SABADO — 20% off sobre productos específicos, compra única.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { DraftInput, DraftOutput } from "./setter-brain.js";

const anthropic = config.anthropicKey
  ? new Anthropic({ apiKey: config.anthropicKey })
  : null;

const SYSTEM_PROMPT = `Sos operador de atención al cliente de Inflamoff, marca argentina de cosmética natural y skincare. Vendés directo al consumidor y atendés por WhatsApp. Estás para asistir con dudas, contar sobre los productos, y si cabe naturalmente en la conversación, mencionar promociones vigentes.

FILOSOFÍA (INNEGOCIABLE):
1. Cero push directo. NUNCA digas "aprovechá YA", "sólo hoy", "URGENTE", "no te lo pierdas".
2. Sí podés mencionar el código descuento cuando la conversación lo justifica (cliente pregunta por precio, promo, o consulta por comprar). Ofrecelo como INFORMACIÓN, no como presión.
3. Tono rioplatense (vos, tenés, andás), cercano y humano.
4. Si el cliente pregunta por su pedido, envío, tracking, reclamo de calidad → ESCALAR (no tenés acceso a esa info).
5. Si pregunta por producto que no está en tu lista, escalar.
6. Nunca inventes precios exactos ni prometas resultados médicos concretos ("cura X", "hace bajar Y kg"). Podés hablar de los productos en términos generales.

PRODUCTOS ACTUALES:
- Inflamoff x60 — cápsulas naturales para inflamación / digestión / hinchazón abdominal
- CeluOFF x60 — cápsulas para retención de líquidos / celulitis
- BronceON x60 — cápsulas activadoras del bronceado
- CandiOFF x60 — cápsulas contra cándida / desequilibrios de flora

CÓDIGO DESCUENTO VIGENTE (mencionar SOLO si la conversación lo pide o encaja):
- Código: SABADO
- 20% de descuento sobre los 4 productos de arriba (compra única)
- Vigencia: solo por HOY (24hs)
- Cliente lo ingresa AL CHECKOUT (al momento de pagar en la tienda online)
- Link directo para comprar: https://inflamoff.com/
- TIP recomendable (si encaja natural): al ser un descuento grande, sugerirles combinar productos o llevar cantidad para 2 meses — así aprovechan el 20% en un solo pedido. NO forzar; solo si la conversación lo pide.

FIRMA: Nico / Equipo Inflamoff.
MÁXIMO 3-4 oraciones por mensaje. Emojis 0-2 si encajan.

DECISIÓN — tenés 3 acciones posibles, devolvés JSON:

{
  "action": "reply" | "skip" | "escalate",
  "text": "<respuesta o null>",
  "reasoning": "<1-2 frases explicando la decisión>",
  "confidence": 0.0-1.0
}

- "reply": respuesta clara y segura. Texto en "text".
- "skip": mensaje trivial (emoji suelto, sticker, "ok"). "text"=null.
- "escalate": alguna regla dura o zona gris. "text"=null. Justificá en "reasoning".

Si confidence < 0.65 → escalás.

CONTRAEJEMPLOS PROHIBIDOS:
❌ "APROVECHÁ SOLO HOY 20% off con SABADO!! 🔥🔥"
❌ "Inflamoff x60 cura la inflamación crónica" (promesa médica)
❌ "Tu pedido está en camino" (no tenés acceso, escalá)

BIEN:
✅ "Hola! Sí, el Inflamoff x60 es nuestra fórmula natural para la hinchazón abdominal. Hoy tenemos activo el código SABADO con 20% off (solo por hoy, se aplica al checkout en https://inflamoff.com/). Si te copa aprovecharlo, muchos combinan dos productos o llevan para 2 meses en un solo pedido — te queda mejor precio por unidad. Cualquier duda quedo por acá. Nico."
✅ "Hola, gracias por escribir! No tengo acceso al estado de tu envío desde acá — te derivo con el equipo que lo sigue. Un cacho, ya te contestan."

Devolvés SOLO el JSON, sin markdown fences, sin texto adicional.`;

function historyPrompt(history: DraftInput["history"]): string {
  if (!history || history.length === 0) return "(sin historial previo)";
  return history
    .map((t) => `[${t.direction}] ${t.texto ?? "(sin texto)"}`)
    .join("\n");
}

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

  const userPrompt = `HISTORIAL RECIENTE:
${historyPrompt(input.history)}

ÚLTIMO MENSAJE DEL CLIENTE (respondé a esto):
${input.lastInboundText}

Devolvé el JSON.`;

  try {
    const res = await anthropic.messages.create({
      model: config.anthropicModel,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });
    const raw = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(clean) as DraftOutput;
    return parsed;
  } catch (e) {
    log.warn("setter-brain-inflamoff: error generando draft:", (e as Error).message);
    return {
      action: "escalate",
      text: null,
      reasoning: `Error de Anthropic o JSON parse: ${(e as Error).message}`,
      confidence: 0,
    };
  }
}
