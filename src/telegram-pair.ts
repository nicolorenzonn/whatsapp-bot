// Pareo interactivo con Telegram — genera un StringSession que después
// se guarda como TELEGRAM_SESSION env var en Railway (no requiere pairing
// en producción, funciona sin TTY).
//
// Uso local:
//   npm run telegram-pair
//
// Te va a pedir:
//   1. Número de teléfono (con código de país, formato +17868247584)
//   2. Código SMS que llega a ese número (via Telegram, no vía SMS carrier)
//   3. Password 2FA (si lo tenés seteado en Telegram; sino Enter en vacío)
//
// Al final imprime un string largo tipo:
//   TELEGRAM_SESSION=1AbHDyN8Ru5b...
//
// Copiá ese valor y setealo en Railway → Variables → TELEGRAM_SESSION.
// Después redeployá y el bot conecta solo sin más interacción.

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
// @ts-expect-error — input no publica types propios y no hay @types/input
import input from "input";
import { config } from "./config.js";
import { log } from "./logger.js";

async function main() {
  if (!config.telegramApiId || !config.telegramApiHash) {
    log.error(
      "Faltan TELEGRAM_API_ID y/o TELEGRAM_API_HASH en tu .env local. " +
      "Obtenelas en https://my.telegram.org → API development tools.",
    );
    process.exit(1);
  }

  log.info(`Iniciando pairing con api_id=${config.telegramApiId}...`);

  const stringSession = new StringSession(""); // arranca vacío
  const client = new TelegramClient(
    stringSession,
    config.telegramApiId,
    config.telegramApiHash,
    { connectionRetries: 5 },
  );

  await client.start({
    phoneNumber: async () =>
      await input.text("Número de teléfono (con +código país, ej +17868247584): "),
    password: async () =>
      await input.text(
        "Password 2FA (Enter en vacío si no tenés 2FA activo): ",
      ),
    phoneCode: async () =>
      await input.text(
        "Código de verificación que llegó a Telegram (5 dígitos): ",
      ),
    onError: (e: unknown) =>
      log.error("telegram-pair error:", e instanceof Error ? e.message : e),
  });

  const me = await client.getMe();
  const meObj = me as { username?: string; firstName?: string };
  log.info("");
  log.info("════════════════════════════════════════════════════");
  log.info(
    `  ✓ Autenticado como @${meObj.username ?? "?"} (${meObj.firstName ?? "?"})`,
  );
  log.info("");
  log.info("  Copiá el siguiente string y guardalo como env var:");
  log.info("  → Railway → Variables → TELEGRAM_SESSION");
  log.info("");
  log.info(`  TELEGRAM_SESSION=${stringSession.save()}`);
  log.info("");
  log.info("  Ese string reemplaza el flujo de SMS — el bot conecta con");
  log.info("  esa sesión sin interacción. Guardalo seguro (es equivalente");
  log.info("  a estar logueado con tu cuenta).");
  log.info("════════════════════════════════════════════════════");

  await client.disconnect();
  process.exit(0);
}

main().catch((e) => {
  log.error("telegram-pair fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
