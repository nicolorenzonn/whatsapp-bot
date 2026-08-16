// Sincroniza los canales Telegram que sigo → wsp_targets con platform='telegram'.
// Corre una vez al boot (después de que connectTelegram tuvo éxito) y cada
// 15 minutos para reflejar canales nuevos que el user haya seguido.
//
// Los targets Telegram quedan en la misma tabla que los WhatsApp — se
// diferencian por la columna platform. El JID usa el prefijo "tg:<channelId>"
// (definido en telegram-client.ts) para evitar colisión con formatos WA.

import { sb } from "./supabase.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { listTelegramChannels, telegramChannelJid } from "./telegram-client.js";

export async function syncTelegramTargets(): Promise<void> {
  const channels = await listTelegramChannels();
  if (channels.length === 0) {
    log.info("telegram-sync: 0 canales Telegram para sincronizar");
    return;
  }
  log.info(`telegram-sync: ${channels.length} canales Telegram encontrados`);

  // Upsert por (user_id, jid) — si ya existe, actualizamos nombre/miembros
  // y last_seen. Si no existe, lo insertamos.
  const rows = channels.map((c) => ({
    user_id: config.userId,
    jid: telegramChannelJid(c.channelId),
    tipo: "canal" as const,
    platform: "telegram" as const,
    nombre: c.title,
    miembros: c.participantsCount,
    last_seen: new Date().toISOString(),
    activo: 1,
  }));

  const { error } = await sb
    .from("wsp_targets")
    .upsert(rows, { onConflict: "user_id,jid" });

  if (error) {
    log.error("telegram-sync: upsert falló:", error.message);
    return;
  }
  log.info(`telegram-sync: ${rows.length} targets Telegram upserted`);
}
