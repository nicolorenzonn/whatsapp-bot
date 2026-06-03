// Conexión a WhatsApp via Baileys.
//
// Baileys es la librería de automation de WhatsApp Web. Funciona simulando
// un dispositivo vinculado: la primera vez te muestra un QR, lo escaneás
// con tu celu en "Dispositivos vinculados", y queda autenticado. Los
// archivos de auth quedan en config.authDir — no se pueden compartir.
//
// El módulo expone connect() que devuelve un socket conectado y maneja
// reconexiones automáticas. Los callers se suscriben a eventos.

import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  type WASocket,
} from "baileys";
import qrcode from "qrcode-terminal";
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "./config.js";
import { log } from "./logger.js";

export interface ConnectOptions {
  // Si es true, mostramos el QR en consola cuando aparece (modo pairing).
  // Si es false (modo daemon), el QR no debería aparecer porque ya hay
  // sesión guardada — si aparece, es un error fatal y la app exit-ea.
  printQR?: boolean;
  // Se llama cuando el socket queda "open" — lista para recibir/enviar.
  onReady?: (sock: WASocket) => void;
}

export async function connect(opts: ConnectOptions = {}): Promise<WASocket> {
  await fs.mkdir(config.authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  log.info(`Baileys version ${version.join(".")}${isLatest ? "" : " (no es la última)"}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // lo manejamos nosotros con qrcode-terminal
    syncFullHistory: false,
    markOnlineOnConnect: false, // que no aparezca "en línea" cuando se conecta
    // Fingerprint: WhatsApp inspecciona el browser string. El label custom
    // "WhatsApp Broadcaster" es una bandera obvia de bot. Browsers.macOS()
    // devuelve ["Mac OS", "Chrome", "14.4.1"] — idéntico a WhatsApp Web
    // en macOS. Misma firma que tendría el cliente oficial.
    browser: Browsers.macOS("Chrome"),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && opts.printQR) {
      log.info("Escaneá este QR desde WhatsApp → Dispositivos vinculados:");
      qrcode.generate(qr, { small: true });
    } else if (qr && !opts.printQR) {
      // En modo daemon no debería aparecer — las creds están vencidas.
      log.error(
        "Apareció un QR en modo daemon — la sesión expiró. Corré `npm run pair` y reescaneá.",
      );
    }

    if (connection === "open") {
      const me = sock.user;
      log.info(`Conectado como ${me?.id ?? "?"} (${me?.name ?? me?.verifiedName ?? "sin nombre"})`);
      opts.onReady?.(sock);
    }

    if (connection === "close") {
      // Boom error con .output.statusCode — el shape de Baileys.
      const err = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
      const code = err?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      log.warn(
        `Desconectado (código ${code ?? "?"}). ${shouldReconnect ? "Reconectando..." : "Logged out — hay que reescanear el QR."}`,
      );
      if (shouldReconnect) {
        setTimeout(() => {
          // Llamada recursiva: nuevo socket. El caller pierde la referencia
          // anterior, pero el daemon escucha onReady y se re-engancha.
          void connect(opts);
        }, 3_000);
      } else {
        // Sesión inválida — limpiar para forzar pair de nuevo.
        log.error("Sesión cerrada definitivamente. Borrá ./auth y corré `npm run pair`.");
        process.exit(1);
      }
    }
  });

  return sock;
}

// Helper: el JID del propio bot (con device suffix). Útil para skipear
// mensajes propios cuando escuchamos eventos.
export function getOwnJid(sock: WASocket): string | null {
  return sock.user?.id ?? null;
}

// Limpia los archivos de auth — útil si querés re-pairar desde cero.
export async function clearAuth(): Promise<void> {
  await fs.rm(config.authDir, { recursive: true, force: true });
}

export const AUTH_DIR = config.authDir;
export { path };
