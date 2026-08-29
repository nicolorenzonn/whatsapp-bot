// Carga y valida variables de entorno. Tira temprano si falta algo
// crítico — preferimos que el bot no arranque a que muera medio loop.
import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Falta env var requerida: ${name}. Mirá .env.example`);
  }
  return v;
}

function optional(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

// Normaliza un número para usar con Baileys requestPairingCode:
// solo dígitos, sin "+" ni espacios. Acepta entrada con o sin formato.
function normalizePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/[^\d]/g, "");
}

// Parsea NEWSLETTER_INVITES (comma-separated). Acepta tanto invite codes
// crudos ("0029VbAUF...") como URLs completas ("https://whatsapp.com/channel/0029...")
// y extrae el código de la URL.
function parseNewsletterInvites(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/channel\/([^/?#]+)/);
      return m ? m[1] : s;
    });
}

export const config = {
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  userId: required("WSP_BOT_USER_ID"),

  anthropicKey: optional("ANTHROPIC_API_KEY"),
  anthropicModel: optional("ANTHROPIC_MODEL", "claude-haiku-4-5")!,

  authDir: path.resolve(optional("WSP_AUTH_DIR", "./auth")!),
  logLevel: optional("LOG_LEVEL", "info")!,

  // Si está seteado, `npm run pair` usa el flow de pairing code (sin QR)
  // — útil para deploys en la nube donde no podés escanear QR de la
  // terminal. Formato: número internacional sin "+" ni espacios.
  // Ej: 5491134567890. En local, dejalo vacío y se cae al QR.
  pairingPhone: normalizePhone(optional("WSP_PAIRING_PHONE")),

  // Lista de invite codes de canales (newsletters) que el bot debe
  // sincronizar manualmente. Útil cuando Baileys no los descubre via
  // messaging-history.set (pasa con WhatsApp Business). Formato:
  // URLs completas o invite codes separados por coma. Ej:
  //   NEWSLETTER_INVITES=https://whatsapp.com/channel/0029Vb...,0029Xy...
  newsletterInvites: parseNewsletterInvites(optional("NEWSLETTER_INVITES")),

  // Puerto del healthcheck HTTP. Railway lo inyecta como PORT.
  healthzPort: parseInt(optional("PORT", "8080")!, 10),

  // Endpoint POST /alert — usado por GH Actions (casino-sync) para
  // notificar fallos consecutivos del scraper de Sportsbet.
  //   WSP_ALERT_TOKEN: token Bearer compartido con el caller. Sin esto
  //                    el endpoint devuelve 503.
  //   WSP_ALERT_DEFAULT_JID: número/JID destino default si el caller
  //                          no manda `to` en el body. Acepta digits
  //                          ("5493434650746") o JID completo
  //                          ("5493434650746@s.whatsapp.net").
  alertToken: optional("WSP_ALERT_TOKEN"),
  alertDefaultJid: optional("WSP_ALERT_DEFAULT_JID"),

  // ── Telegram (GramJS, MTProto) ───────────────────────────────────────────
  // Solo se activa si TELEGRAM_API_ID + TELEGRAM_API_HASH están seteados.
  //
  // Cómo obtenerlas: https://my.telegram.org → API development tools →
  // crear una app (Other) → copiar api_id (número) y api_hash (hex).
  //
  // Auth flow:
  //   1. Primera vez: correr `npm run telegram-pair` local → pide teléfono
  //      + código SMS + 2FA (si tiene) → imprime StringSession al final.
  //   2. Copiás ese string y lo setteás como TELEGRAM_SESSION en Railway.
  //   3. En producción el bot conecta con ese session (sin interacción).
  //
  // Si TELEGRAM_SESSION está vacío y estamos en Railway (sin TTY), el bot
  // no arranca el cliente Telegram — loguea warning y sigue con WhatsApp
  // solo. No es fatal.
  telegramApiId: parseInt(optional("TELEGRAM_API_ID", "0")!, 10),
  telegramApiHash: optional("TELEGRAM_API_HASH"),
  telegramSession: optional("TELEGRAM_SESSION"),

  // Modo del bot — segmenta wsp_tasks/wsp_targets/wsp_conversations por
  // marca así podemos correr múltiples instancias con el mismo user_id
  // pero cada una sirviendo a un cerebro y un número WhatsApp distintos.
  // 'casino' (default) = setter-brain Sportsbet
  // 'inflamoff' = setter-brain Inflamoff (código descuento, productos)
  botMode: optional("BOT_MODE", "casino")!,

  botVersion: "0.3.0",
};
