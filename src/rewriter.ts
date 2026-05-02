// Reescritor opcional de mensajes con Claude.
//
// Cuando una tarea tiene `variar_con_ia=1`, antes de enviar le pedimos a
// Claude que reescriba el texto manteniendo el sentido pero variando
// vocabulario / estructura, para que mensajes que se mandan repetidamente
// no parezcan idénticos (anti-detección por hash).
//
// Si ANTHROPIC_API_KEY no está configurada, esta función devuelve el
// mensaje original sin tocar — la opción se vuelve un no-op.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { log } from "./logger.js";

const anthropic = config.anthropicKey
  ? new Anthropic({ apiKey: config.anthropicKey })
  : null;

export async function variarMensaje(original: string): Promise<string> {
  if (!anthropic) {
    log.debug("variar_con_ia=1 pero falta ANTHROPIC_API_KEY — uso original");
    return original;
  }

  try {
    const res = await anthropic.messages.create({
      model: config.anthropicModel,
      max_tokens: 1024,
      system:
        "Reescribís el mensaje de WhatsApp que te pasen, manteniendo EXACTAMENTE el mismo sentido, " +
        "tono, idioma, longitud aproximada, emojis y formato (saltos de línea, *negritas*, etc). " +
        "Variás solo el vocabulario y el orden de algunas frases para que no sea byte-idéntico al " +
        "original. Devolvés SOLO el mensaje reescrito, sin comillas, sin explicaciones, sin prefijos.",
      messages: [{ role: "user", content: original }],
    });
    const block = res.content[0];
    if (block?.type === "text") {
      return block.text.trim();
    }
    return original;
  } catch (e) {
    log.warn("Rewriter falló — uso mensaje original:", e instanceof Error ? e.message : e);
    return original;
  }
}
