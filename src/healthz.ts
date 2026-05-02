// Mini servidor HTTP para healthcheck de Railway / Fly / cualquier
// orquestador. Responde:
//   GET /healthz       → 200 si bot está conectado a WhatsApp, 503 si no
//   GET /              → mismo que /healthz pero más amigable
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

export function setHealthInfoProvider(fn: () => Omit<HealthInfo, "uptimeSec">): void {
  getInfo = () => ({ ...fn(), uptimeSec: Math.floor((Date.now() - startedAt) / 1_000) });
}

export function startHealthzServer(): http.Server {
  const port = config.healthzPort;
  const server = http.createServer((req, res) => {
    const info = getInfo();
    if (req.url === "/healthz" || req.url === "/") {
      const ok = info.status === "connected";
      res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok,
        status: info.status,
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
