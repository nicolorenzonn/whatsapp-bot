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

  // Puerto del healthcheck HTTP. Railway lo inyecta como PORT.
  healthzPort: parseInt(optional("PORT", "8080")!, 10),

  botVersion: "0.2.0",
};
