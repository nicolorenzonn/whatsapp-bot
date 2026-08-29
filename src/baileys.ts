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
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { config } from "./config.js";
import { log } from "./logger.js";

// Nombre del flag file que escribimos cuando WhatsApp tira loggedOut.
// El daemon lo lee al boot y si existe, wipea el authDir ANTES de que
// useMultiFileAuthState cargue las creds malas. Mecanismo atómico — no
// depende de timing entre cleanup en shutdown y restart.
export const INVALIDATED_FLAG = ".invalidated";

export interface ConnectOptions {
  // Si es true, mostramos el QR en consola cuando aparece (modo pairing).
  // Si es false (modo daemon), suprimimos el QR — preferimos pairing code.
  printQR?: boolean;
  // Se llama cuando el socket queda "open" — lista para recibir/enviar.
  onReady?: (sock: WASocket) => void;
  // Si está seteado Y no hay creds registradas, pedimos pairing code
  // inmediatamente después de makeWASocket (NO después). La API de
  // Baileys requiere que requestPairingCode se llame antes de que el
  // socket entre en flujo de QR, sino los dos flujos se pisan y
  // WhatsApp tira "código incorrecto".
  pairingPhone?: string;
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

  // ── Pairing code (DISPARADO POR EL PRIMER EVENTO qr) ────────────────────
  // Patrón correcto de Baileys: esperar al primer evento qr del socket
  // antes de llamar requestPairingCode. Ahí Baileys ya terminó el handshake
  // websocket inicial y está listo para negociar pairing.
  //
  // El fix anterior (post-makeWASocket inmediato) era demasiado temprano
  // — el call llegaba antes del handshake y WhatsApp cerraba la conexión
  // con "Connection Closed". Síntoma: requestPairingCode falló en todos
  // los intentos.
  //
  // Retry: una vez que tiramos el primer code, refrescamos cada 65s (el
  // código dura ~60s en WhatsApp). El interval se limpia en
  // connection="open".
  let pairingInterval: NodeJS.Timeout | null = null;
  let pairingAttempt = 0;
  let pairingArmed = false; // true después del primer qr → activamos retry loop
  const requestPairing = async (): Promise<void> => {
    if (!opts.pairingPhone) return;
    if (sock.authState.creds.registered) return;
    pairingAttempt++;
    try {
      const code = await sock.requestPairingCode(opts.pairingPhone);
      const formatted = code.match(/.{1,4}/g)?.join("-") ?? code;
      log.info("");
      log.info("════════════════════════════════════════════════════");
      log.info(`  PAIRING CODE (intento #${pairingAttempt}): ${formatted}`);
      log.info(`  Válido ~60s. Si expira, esperá 65s — se regenera solo.`);
      log.info("");
      log.info(`  Número esperado: +${opts.pairingPhone}`);
      log.info("  En tu celu: WhatsApp → Configuración →");
      log.info("  Dispositivos vinculados → Vincular un dispositivo →");
      log.info("  'Vincular con número de teléfono' (botón chico abajo) →");
      log.info("  ingresá el número y después el código de arriba.");
      log.info("════════════════════════════════════════════════════");
      log.info("");
    } catch (e) {
      log.error("requestPairingCode falló:", e instanceof Error ? e.message : e);
    }
  };

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    // PRIMER evento qr: si tenemos pairingPhone y no estamos registrados,
    // ahí disparamos el pairing code request (socket ya está listo).
    // pairingArmed garantiza que el setInterval se arma una sola vez.
    if (qr && opts.pairingPhone && !sock.authState.creds.registered && !pairingArmed) {
      pairingArmed = true;
      void requestPairing();
      pairingInterval = setInterval(() => void requestPairing(), 65_000);
    }

    // Modo pair manual local: mostrar QR en terminal.
    if (qr && opts.printQR && !opts.pairingPhone) {
      log.info("Escaneá este QR desde WhatsApp → Dispositivos vinculados:");
      qrcode.generate(qr, { small: true });
      // También logueamos el string raw en una línea aparte — cuando el bot
      // corre en Railway el ASCII se distorsiona por line-wrapping, así que
      // podemos generar una imagen desde el raw string en la máquina local.
      log.info(`QR_RAW: ${qr}`);
    }
    // En modo pairing-code, ignoramos silenciosamente los QR subsiguientes.

    if (connection === "open") {
      // Pareado/conectado — apagamos el loop de pairing si estaba activo.
      if (pairingInterval) {
        clearInterval(pairingInterval);
        pairingInterval = null;
        log.info("Pairing completado — frenando loop de códigos.");
      }
      const me = sock.user;
      log.info(`Conectado como ${me?.id ?? "?"} (${me?.name ?? me?.verifiedName ?? "sin nombre"})`);
      opts.onReady?.(sock);
    }

    if (connection === "close") {
      // Cleanup del interval de pairing si quedó vivo.
      if (pairingInterval) {
        clearInterval(pairingInterval);
        pairingInterval = null;
      }
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
        // Sesión revocada por WhatsApp (loggedOut, código 401). Escribimos
        // un flag file sincrónico — el daemon lo lee al próximo arranque
        // (ANTES de cargar creds) y wipea el authDir. Sync write porque
        // process.exit no puede interrumpir un write síncrono, garantiza
        // que el flag queda en disco. Versión async previa (clearAuth ->
        // process.exit) tenía race conditions con el container restart de
        // Railway donde el rm no fsync-eaba antes del kill.
        log.error("Sesión revocada por WhatsApp (loggedOut).");
        try {
          if (!existsSync(config.authDir)) mkdirSync(config.authDir, { recursive: true });
          writeFileSync(path.join(config.authDir, INVALIDATED_FLAG), new Date().toISOString());
          log.error(`Flag escrito: ${path.join(config.authDir, INVALIDATED_FLAG)}`);
          log.error("Saliendo — Railway reinicia y el daemon wipea authDir al boot antes de cargar creds.");
        } catch (e) {
          log.error("No pude escribir flag de invalidación:", e instanceof Error ? e.message : e);
        }
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
