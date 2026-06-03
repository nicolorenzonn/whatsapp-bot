// Mini servidor HTTP para healthcheck de Railway / Fly / cualquier
// orquestador. Responde:
//   GET /healthz       → 200 si bot está conectado a WhatsApp, 503 si no
//   GET /              → mismo que /healthz pero más amigable
//   POST /alert        → envía un DM a un número (auth con WSP_ALERT_TOKEN).
//                        Lo usa GH Actions (casino-sync) cuando el scraper
//                        falla N veces consecutivas para avisar al owner.
//   *                  → 404
//
// Railway hace polling a /healthz cada N segundos; si tira 503 o no
// responde, reinicia el container. Eso es lo que queremos: si Baileys
// queda muerto, mejor reiniciar.

import http from "node:http";
import { config } from "./config.js";
import { log } from "./logger.js";

interface HealthInfo {
  status: "connected" | "disconnected" | "pairing" | "error";
  numero: string | null;
  uptimeSec: number;
}

let getInfo: () => HealthInfo = () => ({
  status: "disconnected",
  numero: null,
  uptimeSec: 0,
});

const startedAt = Date.now();

// Boot grace period: devolvemos 200 a /healthz por los primeros 15 min
// aunque el bot no esté conectado. Esto da tiempo a que un re-pairing
// flow complete (request code → user lee logs → entra código en celu →
// Baileys confirma). Sin esto, Railway tira healthcheck timeout (~5min)
// y mata el deploy antes de que el user alcance a leer el código.
// Tras los 15 min volvemos al comportamiento estricto (connected o 503).
const BOOT_GRACE_SEC = 15 * 60;

export function setHealthInfoProvider(fn: () => Omit<HealthInfo, "uptimeSec">): void {
  getInfo = () => ({ ...fn(), uptimeSec: Math.floor((Date.now() - startedAt) / 1_000) });
}

// Callback que el daemon registra cuando el socket está listo. healthz no
// importa Baileys directamente — recibe la función de send via setter.
type AlertSender = (jid: string, text: string) => Promise<unknown>;
let alertSender: AlertSender | null = null;

export function setAlertSender(fn: AlertSender | null): void {
  alertSender = fn;
}

/** Normaliza un número de teléfono a JID de WhatsApp.
 *  Acepta:  "5493434650746"  →  "5493434650746@s.whatsapp.net"
 *  Acepta:  "5493434650746@s.whatsapp.net"  →  unchanged
 *  Acepta:  "+54 9 343 4650746"  →  digits-only → "5493434650746@s.whatsapp.net" */
function normalizeJid(raw: string): string {
  if (raw.includes("@")) return raw;
  const digits = raw.replace(/[^\d]/g, "");
  return `${digits}@s.whatsapp.net`;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleAlert(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Auth: header `Authorization: Bearer <token>` debe matchear WSP_ALERT_TOKEN.
  const token = config.alertToken;
  if (!token) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "WSP_ALERT_TOKEN no configurado" }));
    return;
  }
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${token}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return;
  }
  if (!alertSender) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Bot todavía no está conectado" }));
    return;
  }

  let body: { to?: string; text?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "JSON inválido" }));
    return;
  }
  const to = (body.to ?? config.alertDefaultJid ?? "").trim();
  const text = (body.text ?? "").trim();
  if (!to) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Falta 'to' (o seteá WSP_ALERT_DEFAULT_JID)" }));
    return;
  }
  if (!text) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Falta 'text'" }));
    return;
  }

  try {
    const jid = normalizeJid(to);
    await alertSender(jid, text);
    log.info(`[alert] DM a ${jid}: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`[alert] fallo enviando DM: ${msg}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: msg }));
  }
}

export function startHealthzServer(): http.Server {
  const port = config.healthzPort;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/alert") {
      void handleAlert(req, res);
      return;
    }
    const info = getInfo();
    if (req.url === "/healthz" || req.url === "/") {
      // Boot grace: durante los primeros BOOT_GRACE_SEC segundos devolvemos
      // 200 aunque no estemos conectados. Esto da tiempo a que Baileys
      // pairee (cuando arrancamos con WSP_FORCE_REPAIR=1 + WSP_PAIRING_PHONE,
      // el user tiene que leer el código y entrarlo en su celu). Sin grace,
      // Railway tira el healthcheck a los ~5min y mata el deploy antes
      // de que termine de pairear. Pasada la grace, /healthz vuelve a
      // exigir status=connected — si el bot muere en runtime, Railway lo
      // detecta y reinicia (que es lo que queremos).
      const inGrace = info.uptimeSec < BOOT_GRACE_SEC;
      const ok = info.status === "connected" || inGrace;
      res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok,
        status: info.status,
        in_boot_grace: inGrace,
        numero: info.numero,
        uptime_sec: info.uptimeSec,
        version: config.botVersion,
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(port, () => {
    log.info(`Healthz HTTP server escuchando en :${port}`);
  });

  return server;
}
