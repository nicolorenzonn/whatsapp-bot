// Entrypoint para parear el bot con tu WhatsApp.
//
// Uso:
//   npm run pair
//
// Dos modos según WSP_PAIRING_PHONE:
//
// A) PAIRING CODE (cloud-friendly, sin QR):
//    Si en .env tenés WSP_PAIRING_PHONE=549...123 (número internacional sin
//    "+", solo dígitos), Baileys pide un código de 8 caracteres a WhatsApp
//    y lo imprime en logs. Vos lo entrás en el celu en:
//      WhatsApp → Configuración → Dispositivos vinculados →
//      Vincular un dispositivo → "Vincular con número de teléfono" (abajo)
//    Es lo que usamos en Railway / Fly / cualquier deploy en la nube.
//
// B) QR (local, sin variable WSP_PAIRING_PHONE):
//    Imprime QR en terminal, lo escaneás. Útil para correr en tu PC.
//
// En cualquiera de los dos: cuando termina el pareo, las credenciales
// quedan en config.authDir y el daemon (`npm start`) las reusa.

import { connect, clearAuth, AUTH_DIR } from "./baileys.js";
import { sb } from "./supabase.js";
import { config } from "./config.js";
import { log } from "./logger.js";

async function main() {
  const usePairingCode = !!config.pairingPhone;
  const mode = usePairingCode ? "pairing-code" : "qr";

  log.info(`Pairing flow [${mode}] — auth dir: ${AUTH_DIR}`);
  log.info("Borrando credenciales viejas si existen...");
  await clearAuth();

  // Marcar status="pairing" en Supabase para que la UI muestre estado.
  await sb.from("wsp_bot_status").upsert({
    user_id: config.userId,
    status: "pairing",
    bot_version: config.botVersion,
    error: null,
  });

  const sock = await connect({
    // En modo pairing-code NO queremos imprimir el QR (Baileys igual lo
    // emite por evento, pero le decimos a baileys.ts que lo ignore).
    printQR: !usePairingCode,
    onReady: async (s) => {
      const me = s.user;
      const numero = me?.id?.split(":")[0]?.split("@")[0] ?? null;
      log.info(`✓ Pareado correctamente con ${numero ?? "?"}`);

      await sb.from("wsp_bot_status").upsert({
        user_id: config.userId,
        status: "connected",
        numero,
        ultimo_heartbeat: new Date().toISOString(),
        bot_version: config.botVersion,
        error: null,
      });

      log.info("Las credenciales quedaron guardadas. Ya podés cerrar este proceso");
      log.info("y arrancar el daemon con: npm start");

      setTimeout(() => process.exit(0), 1_000);
    },
  });

  // ── Modo pairing code ─────────────────────────────────────────────────
  if (usePairingCode) {
    // Esperamos que el WS esté listo antes de pedir el code. 3s alcanza
    // en la mayoría de los casos; si no, el caller (Railway) reintenta.
    await new Promise((r) => setTimeout(r, 3_000));

    if (!sock.authState.creds.registered) {
      try {
        const code = await sock.requestPairingCode(config.pairingPhone!);
        const formatted = code.match(/.{1,4}/g)?.join("-") ?? code;
        log.info("");
        log.info("════════════════════════════════════════════════════");
        log.info(`  PAIRING CODE: ${formatted}`);
        log.info("");
        log.info("  En tu celular abrí WhatsApp y andá a:");
        log.info("  Configuración → Dispositivos vinculados →");
        log.info("  Vincular un dispositivo →");
        log.info("  'Vincular con número de teléfono' (abajo) →");
        log.info("  ingresá el código de arriba.");
        log.info("════════════════════════════════════════════════════");
        log.info("");
      } catch (e) {
        log.error("requestPairingCode falló:", e instanceof Error ? e.message : e);
        await sb.from("wsp_bot_status").upsert({
          user_id: config.userId,
          status: "error",
          error: `pair: requestPairingCode falló: ${e instanceof Error ? e.message : String(e)}`,
        });
        process.exit(1);
      }
    } else {
      log.warn("creds.registered=true antes de pedir pairing code — la sesión ya estaba parada?");
    }
  }

  // Timeout global de 5 min (un poco más generoso que QR porque el user
  // puede tardar más en entrar el código a mano).
  setTimeout(() => {
    log.error("Timeout esperando pareo (5 min). Probá de nuevo.");
    void sb.from("wsp_bot_status").upsert({
      user_id: config.userId,
      status: "error",
      error: "pair: timeout esperando pareo",
    });
    process.exit(1);
  }, 5 * 60_000);

  void sock;
}

main().catch((e) => {
  log.error("Pair fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
