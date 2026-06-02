// Generador de "frase del día" — mentalidad / mindset.
//
// Cuando una tarea tiene el placeholder `{{FRASE_DEL_DIA}}` en el mensaje,
// el daemon lo reemplaza con la frase generada por esta función antes de
// enviar. Cacheado por (taskId, día calendario en TZ) — misma task que
// corre dos veces el mismo día reusa la misma frase. Cambia de día, nueva
// frase.
//
// Si ANTHROPIC_API_KEY no está, devolvemos un fallback ya canonizado y
// loggeamos un warn — la tarea no se rompe.
//
// Política anti-alucinación: el system prompt es estricto. Le decimos
// SOLO frases reales, atribución verificable, si dudás usá una ultra
// conocida. Mejor repetir clásicas que inventar autores.
//
// Formato de salida fijo:
//   «frase»
//   — Autor
//
// (con saltos de línea reales — WhatsApp respeta el formato)

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { log } from "./logger.js";

const anthropic = config.anthropicKey
  ? new Anthropic({ apiKey: config.anthropicKey })
  : null;

// Caché in-memory: taskId → { fecha YYYY-MM-DD en TZ de la task, frase formateada }.
const cachePorTask = new Map<number, { fecha: string; frase: string }>();

function fechaEnTz(tz: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

// Fallback rotatorio si Claude no está disponible. 14 frases ultra
// conocidas, atribución 100% verificada — rotamos por día del mes
// (módulo 14) para que dé variedad mínima sin repetir el mismo día.
const FALLBACK_FRASES: { texto: string; autor: string }[] = [
  { texto: "La calidad de tu vida depende de la calidad de tus pensamientos.", autor: "Marco Aurelio" },
  { texto: "El obstáculo es el camino.", autor: "Marco Aurelio" },
  { texto: "No es lo que te pasa, sino cómo reaccionás a lo que te pasa lo que importa.", autor: "Epicteto" },
  { texto: "Si querés algo que nunca tuviste, tenés que hacer algo que nunca hiciste.", autor: "Thomas Jefferson" },
  { texto: "La disciplina es elegir entre lo que querés ahora y lo que más querés.", autor: "Abraham Lincoln" },
  { texto: "El éxito es ir de fracaso en fracaso sin perder el entusiasmo.", autor: "Winston Churchill" },
  { texto: "Sé el cambio que querés ver en el mundo.", autor: "Mahatma Gandhi" },
  { texto: "Lo opuesto al amor no es el odio, es la indiferencia.", autor: "Elie Wiesel" },
  { texto: "El hombre que mueve montañas comienza cargando piedras pequeñas.", autor: "Confucio" },
  { texto: "Si pensás que podés o que no podés, en ambos casos tenés razón.", autor: "Henry Ford" },
  { texto: "Riqueza es tener libertad para decidir cómo usar tu tiempo.", autor: "Naval Ravikant" },
  { texto: "Lo que se mide, se mejora.", autor: "Peter Drucker" },
  { texto: "La paciencia es amarga, pero su fruto es dulce.", autor: "Jean-Jacques Rousseau" },
  { texto: "El que tiene un porqué para vivir puede soportar casi cualquier cómo.", autor: "Friedrich Nietzsche" },
];

function fraseFallback(at: Date = new Date()): string {
  const ymd = at.toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  const dayNum = Number(ymd.replaceAll("-", ""));
  const pick = FALLBACK_FRASES[dayNum % FALLBACK_FRASES.length]!;
  return `«${pick.texto}»\n— ${pick.autor}`;
}

export async function generarFraseDelDia(
  taskId: number,
  tz: string = "America/Argentina/Buenos_Aires",
): Promise<string> {
  // Hit de caché: misma task + mismo día → reusar.
  const hoy = fechaEnTz(tz);
  const hit = cachePorTask.get(taskId);
  if (hit && hit.fecha === hoy) {
    log.debug(`frase del día cache hit task=${taskId} fecha=${hoy}`);
    return hit.frase;
  }

  if (!anthropic) {
    log.warn("Sin ANTHROPIC_API_KEY — uso frase fallback del día");
    const frase = fraseFallback();
    cachePorTask.set(taskId, { fecha: hoy, frase });
    return frase;
  }

  try {
    const res = await anthropic.messages.create({
      model: config.anthropicModel,
      max_tokens: 300,
      // Pasamos la fecha como variabilidad para que no devuelva siempre
      // la misma frase. Cambia el día → cambia el contexto → cambia la
      // frase. (Más confiable que pedirle "dame variedad" en texto libre.)
      system:
        "Sos un curador de citas motivacionales sobre MENTALIDAD, mindset, disciplina, " +
        "estoicismo, perseverancia, foco y crecimiento personal.\n\n" +
        "REGLAS DURAS (no negociables):\n" +
        "1. SOLO citas REALES de personas reales. NUNCA inventes una frase ni atribuyas mal.\n" +
        "2. Si dudás de la autoría de una frase, NO la uses. Mejor repetir un clásico ultra " +
        "conocido (Marco Aurelio, Séneca, Epicteto, Mandela, Gandhi, Jobs, Buffett, Munger, " +
        "Naval Ravikant, Drucker, Nietzsche, Confucio, Churchill, Lincoln) que arriesgar una " +
        "atribución falsa.\n" +
        "3. NO uses frases atribuidas erróneamente en redes (ej: NO atribuir a Einstein la frase " +
        "de la locura/resultados distintos — no es de él; NO atribuir a Gandhi 'sé el cambio…' " +
        "como cita literal, parafraseala o usá otra).\n" +
        "4. Variedad: en distintas ejecuciones, alterná entre filósofos estoicos, empresarios, " +
        "atletas, escritores, líderes. Que no sean todas del mismo.\n" +
        "5. Tono: contundente, breve. Que pegue. Evitá frases cursis de Pinterest.\n\n" +
        "FORMATO DE SALIDA (estricto, sin variaciones):\n" +
        "«[frase en una o dos oraciones, máx 200 caracteres]»\n" +
        "— [Nombre del autor]\n\n" +
        "Nada más. Sin saludo, sin emojis, sin explicaciones, sin contexto, sin comillas " +
        "alrededor de toda la respuesta. Solo la frase entre comillas angulares « » y debajo " +
        "el autor con guion largo.",
      messages: [
        {
          role: "user",
          content: `Frase motivacional sobre mentalidad para hoy ${hoy}. Una sola.`,
        },
      ],
    });
    const block = res.content[0];
    const texto = block?.type === "text" ? block.text.trim() : "";

    // Validación mínima: tiene que tener al menos un « y un — o un -.
    // Si no, caemos al fallback.
    if (!texto || !texto.includes("«") || !/[—-]/.test(texto)) {
      log.warn(`Frase generada no tiene formato esperado, uso fallback. Texto: "${texto}"`);
      const frase = fraseFallback();
      cachePorTask.set(taskId, { fecha: hoy, frase });
      return frase;
    }

    cachePorTask.set(taskId, { fecha: hoy, frase: texto });
    return texto;
  } catch (e) {
    log.warn("Generación de frase del día falló — uso fallback:", e instanceof Error ? e.message : e);
    const frase = fraseFallback();
    cachePorTask.set(taskId, { fecha: hoy, frase });
    return frase;
  }
}

export const FRASE_PLACEHOLDER = "{{FRASE_DEL_DIA}}";
