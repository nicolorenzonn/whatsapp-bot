// Cliente de Telegram vía GramJS (MTProto).
//
// Uso del usuario final: leer canales de Telegram que seguís y disparar el
// mismo pipeline de auto-forward que WhatsApp (Claude reescribe + suffix).
//
// Requisitos:
//   - TELEGRAM_API_ID y TELEGRAM_API_HASH (obtenidos en my.telegram.org)
//   - TELEGRAM_SESSION (StringSession generado con `npm run telegram-pair`)
//
// Si falta cualquiera de los tres, connect() devuelve null y el daemon
// sigue funcionando solo con WhatsApp. No es fatal.
//
// Arquitectura:
//   1. Al arrancar, connect() crea un TelegramClient con StringSession.
//   2. Se suscribe al evento NewMessage (equivalente Telegram de
//      messages.upsert de Baileys).
//   3. Para cada mensaje entrante, invoca handleTelegramMessage con:
//        - sourceJid: "tg:<channelId>" (namespaced para no chocar con JIDs WA)
//        - text: contenido del mensaje
//        - hasMedia: si el mensaje tiene foto/video/etc
//   4. El pipeline decide qué hacer (skip si no hay texto, reescribir con
//      Claude, publicar en WhatsApp con suffix).

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { config } from "./config.js";
import { log } from "./logger.js";

// Prefijo que agregamos al channelId de Telegram para armar un "jid virtual"
// único que no choque con los JIDs de WhatsApp (que terminan en @g.us,
// @newsletter, @s.whatsapp.net). Ejemplo: "tg:1234567890".
export const TELEGRAM_JID_PREFIX = "tg:";

export function telegramChannelJid(channelId: string | number | bigint): string {
  return `${TELEGRAM_JID_PREFIX}${channelId.toString()}`;
}

export function isTelegramJid(jid: string): boolean {
  return jid.startsWith(TELEGRAM_JID_PREFIX);
}

// Callback que recibe cada mensaje entrante de Telegram. Lo va a implementar
// auto-forward.ts (o similar) para engancharse al pipeline existente.
export type TelegramMessageHandler = (evt: {
  sourceJid: string;      // "tg:<channelId>" — matcheable contra wsp_forwards
  sourceName: string;     // Título del canal para logs
  text: string | null;    // Texto del mensaje (null si solo media)
  hasMedia: boolean;      // Foto/video/doc/sticker
  raw: NewMessageEvent;   // Evento crudo por si necesitamos algo específico
}) => void | Promise<void>;

let currentClient: TelegramClient | null = null;

// Devuelve true si config está completa como para conectar. Se usa para
// decidir si el daemon activa el flow de Telegram al arrancar.
export function telegramConfigured(): boolean {
  return (
    !!config.telegramApiId &&
    config.telegramApiId > 0 &&
    !!config.telegramApiHash &&
    !!config.telegramSession
  );
}

/**
 * Conecta el cliente Telegram y engancha el handler para cada mensaje nuevo.
 * Devuelve el cliente si conectó, o null si falta config o falla la auth.
 * NO tira excepción — falla silenciosa loggeada, para que WhatsApp siga
 * funcionando independiente.
 */
export async function connectTelegram(
  onMessage: TelegramMessageHandler,
): Promise<TelegramClient | null> {
  if (!telegramConfigured()) {
    log.info(
      "telegram: config incompleta (falta TELEGRAM_API_ID/HASH/SESSION) — skip",
    );
    return null;
  }

  const stringSession = new StringSession(config.telegramSession ?? "");
  const client = new TelegramClient(
    stringSession,
    config.telegramApiId,
    config.telegramApiHash!,
    {
      connectionRetries: 5,
      // GramJS por defecto usa el DC correcto según auth. Solo lo forzaríamos
      // si tuviéramos problemas de routing.
    },
  );

  try {
    // start() con sesión ya autenticada no pide nada — solo conecta.
    // Si por algún motivo la sesión es inválida, tira excepción.
    await client.start({
      phoneNumber: async () => {
        throw new Error(
          "telegram: sesión inválida y no hay flujo interactivo disponible en daemon. " +
          "Regenerá TELEGRAM_SESSION corriendo `npm run telegram-pair` local.",
        );
      },
      password: async () => "",
      phoneCode: async () => "",
      onError: (e: unknown) => log.error("telegram start error:", e instanceof Error ? e.message : e),
    });
    const me = await client.getMe();
    // .username / .firstName / .id según el tipo User de GramJS
    const meObj = me as { username?: string; firstName?: string; id?: unknown };
    log.info(
      `telegram: conectado como @${meObj.username ?? "?"} (${meObj.firstName ?? "?"})`,
    );
  } catch (e) {
    log.error("telegram: no pude conectar —", e instanceof Error ? e.message : e);
    return null;
  }

  // Suscribirse a mensajes nuevos. NewMessage sin filtros = todos los chats
  // que el usuario tiene visibles (incluye canales que sigue, DMs, grupos).
  // Filtramos por canal en el handler contra las reglas de wsp_forwards.
  client.addEventHandler(async (event: NewMessageEvent) => {
    try {
      const msg = event.message;
      if (!msg) return;

      // Extraer channel/chat id — para canales de broadcast es peerId.channelId
      const peer = msg.peerId as unknown as {
        channelId?: bigint | number | string;
        chatId?: bigint | number | string;
        userId?: bigint | number | string;
      };
      const rawId =
        peer?.channelId ?? peer?.chatId ?? peer?.userId ?? null;
      if (rawId === null) return;

      const sourceJid = telegramChannelJid(rawId);

      // Nombre del chat para logs — puede requerir extra fetch pero GramJS
      // suele cachear. Si no lo conseguimos, usamos el ID.
      let sourceName = sourceJid;
      try {
        const chat = await msg.getChat();
        const c = chat as unknown as { title?: string; username?: string; firstName?: string };
        sourceName = c?.title ?? c?.username ?? c?.firstName ?? sourceJid;
      } catch {
        // no-op — sigue el ID como nombre
      }

      const text = msg.message ?? null;
      const hasMedia = !!msg.media;

      await onMessage({ sourceJid, sourceName, text, hasMedia, raw: event });
    } catch (e) {
      log.error(
        "telegram: error procesando mensaje entrante:",
        e instanceof Error ? e.message : e,
      );
    }
  }, new NewMessage({}));

  currentClient = client;
  return client;
}

/**
 * Fetch de los canales que el user sigue (dialogs de tipo Channel broadcast).
 * Se usa en telegram-sync-targets para poblar wsp_targets con platform='telegram'.
 * Devuelve array de { channelId, title, participantsCount }.
 */
export async function listTelegramChannels(): Promise<
  Array<{ channelId: string; title: string; participantsCount: number | null }>
> {
  const client = currentClient;
  if (!client) {
    log.warn("telegram: listTelegramChannels llamado sin cliente conectado");
    return [];
  }
  const out: Array<{ channelId: string; title: string; participantsCount: number | null }> = [];
  try {
    const dialogs = await client.getDialogs({});
    for (const d of dialogs) {
      // Solo channels broadcast (los "canales" tipo announcement de TG).
      // No grupos privados ni DMs — para eso el user usaría reglas manuales.
      const entity = d.entity as unknown as {
        className?: string;
        broadcast?: boolean;
        id?: bigint | number;
        title?: string;
        participantsCount?: number;
      };
      if (entity?.className === "Channel" && entity.broadcast) {
        out.push({
          channelId: entity.id!.toString(),
          title: entity.title ?? "(sin título)",
          participantsCount: entity.participantsCount ?? null,
        });
      }
    }
  } catch (e) {
    log.error("telegram: listTelegramChannels falló:", e instanceof Error ? e.message : e);
  }
  return out;
}

export function getTelegramClient(): TelegramClient | null {
  return currentClient;
}
