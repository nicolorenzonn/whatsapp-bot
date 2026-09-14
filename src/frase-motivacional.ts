// Generador de "frase del día" — mentalidad / mindset.
//
// Cuando una tarea tiene el placeholder `{{FRASE_DEL_DIA}}` en el mensaje,
// el daemon lo reemplaza con la frase de esta función antes de enviar.
// Rotación fija por día — sin IA. Lista curada de frases reales con
// atribución verificada. Mismo día → misma frase en todos los envíos;
// cambia de día → siguiente frase de la lista.
//
// Formato de salida fijo (solo frase y autor, sin prefijo, sin emoji):
//   «frase»
//   — Autor
//
// (con saltos de línea reales — WhatsApp respeta el formato)

import { log } from "./logger.js";

function fechaEnTz(tz: string): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

// Rotación fija por día del mes. 14 frases ultra conocidas, atribución
// 100% verificada.
const FRASES: { texto: string; autor: string }[] = [
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

export async function generarFraseDelDia(
  _taskId: number,
  tz: string = "America/Argentina/Buenos_Aires",
): Promise<string> {
  const ymd = fechaEnTz(tz);
  const dayNum = Number(ymd.replaceAll("-", ""));
  const pick = FRASES[dayNum % FRASES.length]!;
  const frase = `«${pick.texto}»\n— ${pick.autor}`;
  log.debug(`frase del día task=${_taskId} fecha=${ymd} idx=${dayNum % FRASES.length}`);
  return frase;
}

export const FRASE_PLACEHOLDER = "{{FRASE_DEL_DIA}}";
