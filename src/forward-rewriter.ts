// Reescritura con IA para reglas de wsp_forwards con mode='ia_rewrite'.
//
// Cuando entra un mensaje en un canal source, en vez de reenviarlo con
// { forward: msg } (que marca "Reenviado" en WhatsApp), pasamos el texto
// por Claude y publicamos el resultado como mensaje NATIVO en el canal
// destino. Sirve para curar contenido de terceros con permiso.
//
// Anti-alucinación: el prompt es estricto sobre no inventar datos. Info
// crítica (partidos, cuotas, links, números, nombres) tiene que quedar
// idéntica byte por byte. Solo cambia forma / vocabulario / orden.
//
// Cache: por (rule_id, hash del texto original) para no reescribir dos
// veces el mismo mensaje (protege contra doble-entrega de Baileys).

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { log } from "./logger.js";

const anthropic = config.anthropicKey
  ? new Anthropic({ apiKey: config.anthropicKey })
  : null;

// Cache in-memory. Key: `${ruleId}::${sha}` del texto original.
// Value: texto reescrito. Se limpia si supera 500 entries (LRU simple).
const cache = new Map<string, string>();
const CACHE_MAX = 500;

function shortHash(s: string): string {
  // FNV-1a 32-bit, suficiente para deduplicar mensajes recientes.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const DEFAULT_PROMPT =
  "Reescribís mensajes de un canal de WhatsApp en español RIOPLATENSE " +
  "(Argentina), tono cercano y natural, como si lo escribieras vos.\n\n" +
  "REGLAS DE FORMA:\n" +
  "• Usá voseo (tenés / querés / mirá / dale).\n" +
  "• Modismos AR naturales cuando encajen (che, dale, mirá, posta, " +
  "buenísimo, ojo). Sin sobrecargar.\n" +
  "• NO uses: tú / vosotros / chévere / genial / cordialmente / " +
  "lenguaje corporativo.\n" +
  "• Podés arrancar informal o directo al grano.\n" +
  "• PROHIBIDO usar la palabra 'boludo' en cualquier forma. Nunca.\n\n" +
  "REGLAS DE CONTENIDO (CRÍTICAS, INVIOLABLES):\n" +
  "• Mantenés EXACTAMENTE la misma información del original: partidos, " +
  "equipos, cuotas, horarios, tipos de apuesta, precios, fechas, links, " +
  "números, nombres. Nada se cambia, nada se agrega, nada se saca.\n" +
  "• Si hay links (http://... o https://...), los dejás IDÉNTICOS byte " +
  "por byte, en una posición razonable del texto.\n" +
  "• Si hay números o estadísticas, quedan exactos.\n" +
  "• Emojis y formato de WhatsApp (*negrita*, _itálica_, saltos de línea) " +
  "los preservás si aportan claridad.\n" +
  "• Largo similar al original (±30%). No lo alargues de gusto ni resumas.\n\n" +
  "OBJETIVO: que el mensaje suene como escrito por vos, no como un forward, " +
  "pero que la información sea EXACTAMENTE la misma que el original.\n\n" +
  "Devolvés SOLO el mensaje reescrito. Sin comillas, sin explicaciones, sin " +
  "prefijos tipo 'Acá va:' ni 'Versión reescrita:'.";

export async function reescribirParaForward(
  ruleId: number,
  original: string,
  customPrompt: string | null,
): Promise<string> {
  // Cache: mismo texto + misma regla → reusar (evita doble reescritura si
  // Baileys entrega el mismo mensaje dos veces por reconexión).
  const cacheKey = `${ruleId}::${shortHash(original)}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) {
    log.debug(`forward-rewriter cache hit rule=${ruleId}`);
    return hit;
  }

  if (!anthropic) {
    log.warn(
      "forward-rewriter: sin ANTHROPIC_API_KEY — devuelvo texto original tal cual",
    );
    return original;
  }

  const systemPrompt = customPrompt?.trim()
    ? customPrompt.trim()
    : DEFAULT_PROMPT;

  try {
    const res = await anthropic.messages.create({
      model: config.anthropicModel,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: original }],
    });
    const block = res.content[0];
    const reescrito = block?.type === "text" ? block.text.trim() : original;

    // Guardar en cache con LRU simple.
    if (cache.size >= CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(cacheKey, reescrito);
    return reescrito;
  } catch (e) {
    log.warn(
      "forward-rewriter: Claude falló — devuelvo texto original:",
      e instanceof Error ? e.message : e,
    );
    return original;
  }
}
