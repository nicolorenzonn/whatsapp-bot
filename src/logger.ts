// Logger minimalista. Para un bot single-user que corre en la PC del dueño
// no necesitamos pino + transports — bastan timestamps + niveles + colores.
import { config } from "./config.js";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const minLevel = LEVELS.indexOf(config.logLevel as Level);
const enabled = (l: Level) => LEVELS.indexOf(l) >= (minLevel < 0 ? 1 : minLevel);

function emit(level: Level, msg: string, extra?: unknown) {
  if (!enabled(level)) return;
  const ts = new Date().toTimeString().slice(0, 8);
  const tag = COLORS[level] + level.toUpperCase().padEnd(5) + RESET;
  const prefix = `${DIM}${ts}${RESET} ${tag}`;
  if (extra !== undefined) {
    console.log(`${prefix} ${msg}`, extra);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
};
