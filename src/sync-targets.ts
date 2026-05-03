// Sincronización de chats/canales/comunidades a la tabla wsp_targets.
//
// Tipos de targets:
//   - grupo      "<num>@g.us"          (sock.groupFetchAllParticipating)
//   - canal      "<num>@newsletter"    (de chatStore que pobla el daemon)
//   - comunidad  "<num>@g.us" + isCommunityAnnounce  (parent de community)
//   - dm         "<num>@s.whatsapp.net" (no relevante para broadcaster)
//
// Baileys 6+ no tiene un endpoint "list mis canales" — los newsletters se
// descubren via eventos (messaging-history.set, chats.upsert). El daemon
// mantiene un Map en memoria con todos los chats vistos y nos lo pasa.

import type { WASocket } from "baileys";
import { sb } from "./supabase.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { TargetTipo } from "./types.js";

// Helper: pausa entre requests para no inundar a WhatsApp
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ChatRow {
  jid: string;
  tipo: TargetTipo;
  nombre: string;
  miembros: number | null;
}

// Shape mínimo que necesitamos del store de chats. Usamos `any` para los
// valores porque Baileys cambia los tipos entre versiones y no queremos
// acoplar fuerte.
export type ChatStore = Map<string, { id: string; name?: string; subject?: string }>;

export async function listarChats(
  sock: WASocket,
  chatStore: ChatStore,
): Promise<ChatRow[]> {
  const rows: ChatRow[] = [];
  const seen = new Set<string>();

  // ── 1) Grupos + comunidades ────────────────────────────────────────────
  // groupFetchAllParticipating devuelve TODOS los grupos donde participás,
  // incluidos los subgrupos de comunidades y la "community announce" parent.
  try {
    const grupos = await sock.groupFetchAllParticipating();
    for (const g of Object.values(grupos)) {
      // Heurística para distinguir comunidad vs grupo común:
      // - WhatsApp Communities: el grupo "padre" tiene flag isCommunity / isCommunityAnnounce
      //   y es el que aparece como cabecera. Los subgrupos tienen linkedParent.
      // - El campo exacto varía entre versiones — usamos `any` y chequeamos
      //   varios candidatos para ser tolerantes.
      const meta = g as unknown as Record<string, unknown>;
      const isCommunity =
        meta.isCommunity === true ||
        meta.isCommunityAnnounce === true ||
        // si el grupo NO tiene parent pero SI lista subgroups, es la community parent
        (Array.isArray(meta.subgroups) && (meta.subgroups as unknown[]).length > 0);

      const tipo: TargetTipo = isCommunity ? "comunidad" : "grupo";

      rows.push({
        jid: g.id,
        tipo,
        nombre: g.subject || "(sin nombre)",
        miembros: g.participants?.length ?? null,
      });
      seen.add(g.id);
    }
    log.debug(`groupFetchAllParticipating → ${Object.keys(grupos).length} grupos/comunidades`);
  } catch (e) {
    log.warn("groupFetchAllParticipating falló:", e instanceof Error ? e.message : e);
  }

  // ── 2) Canales (newsletters) ───────────────────────────────────────────
  // Los eventos messaging-history.set / chats.upsert NO traen name ni subject
  // para newsletters — solo el JID. Hidratamos el nombre (y subscribers) con
  // sock.newsletterMetadata("jid", id). Lo hacemos secuencial con sleep igual
  // que la sección 3 para no rate-limitearnos. El nombre obtenido se cachea
  // en c.name del chatStore: re-syncs siguientes (cada 10 min) son 0 fetches.
  let nCanales = 0;
  let nHidratados = 0;
  for (const c of chatStore.values()) {
    if (!c.id?.endsWith("@newsletter")) continue;
    if (seen.has(c.id)) continue;

    let nombre = c.name || c.subject;
    let miembros: number | null = null;

    if (!nombre) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sockAny = sock as any;
        const meta = await sockAny.newsletterMetadata("jid", c.id);
        if (meta?.name || meta?.subject) {
          nombre = meta.name || meta.subject;
          c.name = nombre; // cache para próximos syncs
          miembros = meta?.subscribers ?? meta?.subscribers_count ?? null;
          nHidratados++;
        }
      } catch (e) {
        log.warn(
          `newsletterMetadata(${c.id}) falló:`,
          e instanceof Error ? e.message : e,
        );
      }
      await sleep(300);
    }

    rows.push({
      jid: c.id,
      tipo: "canal",
      nombre: nombre || "(canal sin nombre)",
      miembros,
    });
    seen.add(c.id);
    nCanales++;
  }
  log.debug(
    `chatStore → ${nCanales} canales (newsletters), ${nHidratados} hidratados via newsletterMetadata`,
  );

  // ── 3) Canales por invite code (env var NEWSLETTER_INVITES) ──────────
  // En WhatsApp Business los newsletters frecuentemente no llegan via
  // messaging-history.set, así que el user puede pegar los invite
  // codes/URLs en NEWSLETTER_INVITES y los fetchamos directamente.
  if (config.newsletterInvites.length > 0) {
    let nInvites = 0;
    let loggedSample = false;
    for (const invite of config.newsletterInvites) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sockAny = sock as any;
        const meta = await sockAny.newsletterMetadata("invite", invite);

        // Diagnóstico: loggear el shape real del primer invite del lote
        // (solo uno para no spamear). Sirve para detectar en qué campo
        // viene el nombre — en algunas versiones está en thread_metadata.
        if (!loggedSample && meta) {
          log.info(
            `[shape] newsletterMetadata("invite") → ${JSON.stringify(meta).slice(0, 600)}`,
          );
          loggedSample = true;
        }

        const id: string | undefined = meta?.id;
        if (!id) {
          log.warn(`Newsletter invite ${invite}: sin ID en respuesta`);
          continue;
        }
        if (seen.has(id)) continue;
        // En Baileys 2.3000.x el nombre viene en thread_metadata.name.text
        // (objeto {id, text, update_time}), no como string al top level.
        // Mantengo los otros paths como fallback por si cambia entre versiones.
        const nombre =
          meta?.thread_metadata?.name?.text ||
          meta?.name ||
          meta?.subject ||
          meta?.title ||
          "(canal sin nombre)";
        rows.push({
          jid: id,
          tipo: "canal",
          nombre,
          miembros:
            meta?.thread_metadata?.subscribers_count ??
            meta?.subscribers ??
            meta?.subscribers_count ??
            null,
        });
        seen.add(id);
        nInvites++;
      } catch (e) {
        log.warn(
          `Newsletter invite ${invite} falló:`,
          e instanceof Error ? e.message : e,
        );
      }
      await sleep(300); // pequeño delay entre requests
    }
    log.info(
      `Newsletters por invite → ${nInvites}/${config.newsletterInvites.length} OK`,
    );
  }

  return rows;
}

export async function syncTargets(
  sock: WASocket,
  chatStore: ChatStore,
): Promise<number> {
  const chats = await listarChats(sock, chatStore);
  if (chats.length === 0) {
    log.info("No se detectaron chats para sincronizar.");
    return 0;
  }

  const now = new Date().toISOString();
  const payload = chats.map((c) => ({
    user_id: config.userId,
    jid: c.jid,
    tipo: c.tipo,
    nombre: c.nombre,
    miembros: c.miembros,
    last_seen: now,
    activo: 1,
  }));

  const { error, count } = await sb
    .from("wsp_targets")
    .upsert(payload, { onConflict: "user_id,jid", count: "exact" });

  if (error) {
    log.error("Error en upsert de wsp_targets:", error.message);
    throw error;
  }

  // Resumen por tipo, útil para debug
  const byTipo = chats.reduce<Record<string, number>>((acc, c) => {
    acc[c.tipo] = (acc[c.tipo] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(byTipo)
    .map(([t, n]) => `${n} ${t}`)
    .join(", ");
  log.info(`Sincronizados ${count ?? chats.length} targets a Supabase (${summary})`);

  // Backfill: hidratar canales legacy en DB que quedaron sin nombre
  // (vinieron de syncs viejos cuando history sync estaba activo, ahora
  // ya no aparecen en chatStore porque syncFullHistory: false).
  await backfillCanalesSinNombre(sock).catch((e) =>
    log.warn("backfill canales falló:", e instanceof Error ? e.message : e),
  );

  return chats.length;
}

// Hidrata canales que ya están en wsp_targets pero quedaron como
// "(canal sin nombre)". Itera la tabla, llama newsletterMetadata("jid", id)
// para cada uno y hace UPDATE in-place. Después del primer pass exitoso,
// las siguientes ejecuciones encuentran 0 filas y son no-op.
async function backfillCanalesSinNombre(sock: WASocket): Promise<void> {
  const { data, error } = await sb
    .from("wsp_targets")
    .select("jid")
    .eq("user_id", config.userId)
    .eq("tipo", "canal")
    .eq("activo", 1) // los que ya marcamos inactivos no se reintentan
    .ilike("nombre", "%sin nombre%");

  if (error) {
    log.warn("backfill: select falló:", error.message);
    return;
  }
  if (!data || data.length === 0) return;

  log.info(`backfill: ${data.length} canales sin nombre → hidratando...`);
  let nOk = 0;
  let nDisabled = 0;
  for (const row of data as Array<{ jid: string }>) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sockAny = sock as any;
      const meta = await sockAny.newsletterMetadata("jid", row.jid);
      const nombre: string | undefined =
        meta?.thread_metadata?.name?.text ||
        meta?.name ||
        meta?.subject ||
        meta?.title;
      if (nombre) {
        const miembros: number | null =
          meta?.thread_metadata?.subscribers_count ??
          meta?.subscribers ??
          meta?.subscribers_count ??
          null;
        const { error: updErr } = await sb
          .from("wsp_targets")
          .update({ nombre, miembros })
          .eq("user_id", config.userId)
          .eq("jid", row.jid);
        if (updErr) {
          log.warn(`backfill update ${row.jid} falló:`, updErr.message);
        } else {
          nOk++;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`backfill ${row.jid} falló:`, msg);
      // "Not Allowed" = el bot no es admin/owner del canal y WhatsApp
      // bloquea newsletterMetadata por GraphQL. No vamos a poder hidratarlo
      // nunca por esta vía → marcar inactivo así no se reintenta cada 10 min.
      if (msg.includes("Not Allowed") || msg.includes("not-allowed")) {
        const { error: updErr } = await sb
          .from("wsp_targets")
          .update({ activo: 0 })
          .eq("user_id", config.userId)
          .eq("jid", row.jid);
        if (!updErr) nDisabled++;
      }
    }
    await sleep(300);
  }
  log.info(
    `backfill: ${nOk}/${data.length} hidratados, ${nDisabled} marcados inactivos`,
  );
}
