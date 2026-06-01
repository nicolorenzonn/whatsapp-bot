// Reescritor opcional de mensajes con Claude.
//
// Cuando una tarea tiene `variar_con_ia=1`, antes de enviar le pedimos a
// Claude que reescriba el texto manteniendo el sentido pero variando
// vocabulario / estructura, para que mensajes que se mandan repetidamente
// no parezcan idénticos (anti-detección por hash).
//
// Si ANTHROPIC_API_KEY no está configurada, esta función devuelve el
// mensaje original sin tocar — la opción se vuelve un no-op.
//
// Caché por (task_id, día calendario): si una task corre varias veces el
// mismo día, todas las ejecuciones usan la misma variante. Cuando cambia
// el día, regenera. Si el daemon reinicia, el caché se pierde y la próxima
// ejecución regenera — peor caso aceptable.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { log } from "./logger.js";

const anthropic = config.anthropicKey
  ? new Anthropic({ apiKey: config.anthropicKey })
  : null;

// Caché in-memory: taskId → { fecha YYYY-MM-DD en TZ de la task, variante }.
const cachePorTask = new Map<number, { fecha: string; mensaje: string }>();

function fechaEnTz(tz: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

// Saca "boludo" / "boluda" / "boluu" / etc. del texto, sin importar dónde
// aparezca. Match case-insensitive con bordes laxos para cazar variantes
// (alargues tipo "boluuu", plurales, comas pegadas). Después colapsa
// espacios duplicados y limpia signos colgados al final.
function limpiarBoludo(texto: string): string {
  if (!texto) return texto;
  const regex = /\bbolu+d?[oa]s?\b[\s,.!¡¿?…—-]*/gi;
  return texto
    .replace(regex, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?…])/g, "$1")
    .replace(/[\s,;:—-]+$/gm, "")
    .trim();
}

export async function variarMensaje(
  original: string,
  taskId?: number,
  tz: string = "America/Argentina/Buenos_Aires",
): Promise<string> {
  if (!anthropic) {
    log.debug("variar_con_ia=1 pero falta ANTHROPIC_API_KEY — uso original");
    return original;
  }

  // Hit de caché: misma task + mismo día → reusar.
  if (taskId !== undefined) {
    const hoy = fechaEnTz(tz);
    const hit = cachePorTask.get(taskId);
    if (hit && hit.fecha === hoy) {
      log.debug(`rewriter cache hit task=${taskId} fecha=${hoy}`);
      return hit.mensaje;
    }
  }

  try {
    const res = await anthropic.messages.create({
      model: config.anthropicModel,
      max_tokens: 1024,
      system:
        "Reescribís un mensaje de WhatsApp en español RIOPLATENSE (Argentina), con tono " +
        "CERCANO, AMIGABLE, COMO UN AMIGO QUE TE ESCRIBE. Nada de neutro, nada de formal, nada " +
        "robótico.\n\n" +
        "REGLAS DE TONO:\n" +
        "• Usá VOSEO siempre (tenés / querés / mirá / fijate / dale).\n" +
        "• Modismos argentinos naturales cuando encajen: \"dale\", \"mirá\", \"posta\", \"ojo\", " +
        "\"copado\", \"buenísimo\", \"está re bueno\", \"che\". Sin sobrecargar.\n" +
        "• NO uses: \"tú\", \"vosotros\", \"chévere\", \"genial\" (sonás de otro país), \"cordialmente\", " +
        "\"saludos cordiales\", lenguaje corporativo o de marketing.\n" +
        "• PROHIBIDO usar la palabra \"boludo\" (en cualquier forma: boludo, boluda, boludos, bolu, " +
        "boluuu, etc.). NI al final del mensaje, NI en el medio, NI como saludo. NUNCA. Es una regla " +
        "DURA — el mensaje se rechaza si aparece.\n" +
        "• Podés arrancar informal: \"hola!\", \"ey\", \"buenas\", o directo al grano.\n\n" +
        "REGLAS DE CONTENIDO (CRÍTICAS):\n" +
        "• Mantenés EXACTAMENTE el mismo sentido y la misma información del original.\n" +
        "• NO inventes datos, precios, fechas, links, números, nombres ni promesas que no estén.\n" +
        "• Si hay un link/URL, lo dejás IGUAL, byte por byte, en una posición razonable del texto.\n" +
        "• Mantenés emojis y formato de WhatsApp (*negrita*, _itálica_, saltos de línea).\n" +
        "• Largo similar al original (±30%), no lo alargues de gusto.\n\n" +
        "OBJETIVO: que cada envío sea distinto al anterior (variás vocabulario y orden de frases) " +
        "pero suene siempre como una persona argentina escribiendo, no como un bot.\n\n" +
        "Devolvés SOLO el mensaje reescrito. Sin comillas, sin explicaciones, sin prefijos tipo " +
        "\"Acá va:\" ni \"Versión:\".",
      messages: [
        {
          role: "user",
          content:
            "Hola! Te queríamos avisar que ya está disponible el nuevo ebook de inversiones. " +
            "Podés descargarlo gratis acá: https://ej.com/ebook",
        },
        {
          role: "assistant",
          content:
            "ey! salió el ebook nuevo de inversiones 🙌 te lo dejo gratis acá: https://ej.com/ebook " +
            "— fijate que está re completo",
        },
        { role: "user", content: original },
      ],
    });
    const block = res.content[0];
    const rawVariado = block?.type === "text" ? block.text.trim() : original;
    // Safety net: aunque el system prompt prohíbe "boludo", a veces Claude
    // se zarpa igual. Filtramos cualquier ocurrencia antes de cachear.
    const variado = limpiarBoludo(rawVariado);

    // Guardar en caché para reusar el resto del día.
    if (taskId !== undefined) {
      cachePorTask.set(taskId, { fecha: fechaEnTz(tz), mensaje: variado });
    }
    return variado;
  } catch (e) {
    log.warn("Rewriter falló — uso mensaje original:", e instanceof Error ? e.message : e);
    return original;
  }
}
