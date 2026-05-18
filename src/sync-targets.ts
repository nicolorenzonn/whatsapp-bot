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

// Extrae el nombre de la respuesta de newsletterMetadata. La shape varía
// entre versiones de Baileys / WhatsApp:
//   - Baileys 2.3000.x: thread_metadata.name = { id, text, update_time }
//   - Otras versiones: meta.name (string) | meta.subject | meta.title
// El backfill ya hacía esto bien — extraído acá para no divergir entre
// las 3 secciones que llaman a newsletterMetadata.
function extractNewsletterName(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta: any,
): { nombre: string | undefined; miembros: number | null } {
  if (!meta) return { nombre: undefined, miembros: null };
  const nombre: string | undefined =
    meta?.thread_metadata?.name?.text ||
    meta?.name ||
    meta?.subject ||
    meta?.title ||
    undefined;
  const miembros: number | null =
    meta?.thread_metadata?.subscribers_count ??
    meta?.subscribers ??
    meta?.subscribers_count ??
    null;
  return { nombre, miembros };
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
  let nSkipped = 0;
  for (const c of chatStore.values()) {
    if (!c.id?.endsWith("@newsletter")) continue;
    if (seen.has(c.id)) continue;

    let nombre: string | undefined = c.name || c.subject;
    let miembros: number | null = null;
    let notAllowed = false;

    if (!nombre) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sockAny = sock as any;
        const meta = await sockAny.newsletterMetadata("jid", c.id);
        const extracted = extractNewsletterName(meta);
        if (extracted.nombre) {
          nombre = extracted.nombre;
          miembros = extracted.miembros;
          c.name = nombre; // cache para próximos syncs (evita re-fetch en chatStore)
          nHidratados++;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // "Not Allowed" = bot no es admin/owner → no podemos hidratar este
        // canal por jid y tampoco podemos enviar a él. Skip total para
        // evitar polución del dashboard con "(canal sin nombre)".
        if (msg.includes("Not Allowed") || msg.includes("not-allowed")) {
          notAllowed = true;
        }
        log.warn(`newsletterMetadata(${c.id}) falló:`, msg);
      }
      await sleep(300);
    }

    // Si no tenemos nombre Y la metadata API nos negó permisos, skip:
    // el canal no es enviable y no aporta nada al dashboard. Si el usuario
    // realmente quiere usarlo, que lo pase via NEWSLETTER_INVITES (sección
    // 3, que usa el endpoint "invite" — público, no necesita admin).
    if (!nombre && notAllowed) {
      nSkipped++;
      seen.add(c.id);
      continue;
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
  log.info(
    `chatStore → ${nCanales} canales pusheados, ${nHidratados} hidratados via newsletterMetadata, ${nSkipped} skipped (sin permiso)`,
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
        const { nombre, miembros } = extractNewsletterName(meta);
        rows.push({
          jid: id,
          tipo: "canal",
          nombre: nombre || "(canal sin nombre)",
          miembros,
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

  // Antes de pushear: leemos los nombres existentes en DB para no pisar
  // un nombre hidratado (real) con "(canal sin nombre)" en este sync.
  // Sin esto teníamos el race: sync mete "(sin nombre)" → backfill lo
  // arregla → próximo sync lo vuelve a pisar → loop infinito.
  const { data: existentes } = await sb
    .from("wsp_targets")
    .select("jid, nombre, activo")
    .eq("user_id", config.userId)
    .in("jid", chats.map((c) => c.jid));
  const nombreExistente = new Map<string, string>();
  const activoExistente = new Map<string, number>();
  for (const r of (existentes ?? []) as Array<{
    jid: string;
    nombre: string;
    activo: number;
  }>) {
    nombreExistente.set(r.jid, r.nombre);
    activoExistente.set(r.jid, r.activo);
  }

  const payload = chats.map((c) => {
    const prevNombre = nombreExistente.get(c.jid);
    const finalNombre =
      // si lo nuevo NO es "(sin nombre)" → usarlo
      // si lo nuevo ES "(sin nombre)" y había uno real en DB → preservar
      c.nombre.includes("sin nombre") && prevNombre && !prevNombre.includes("sin nombre")
        ? prevNombre
        : c.nombre;
    return {
      user_id: config.userId,
      jid: c.jid,
      tipo: c.tipo,
      nombre: finalNombre,
      miembros: c.miembros,
      last_seen: now,
      // Si la fila ya existe, preservar el activo que tenía (puede haber
      // sido desactivada por backfill). Solo seteamos activo=1 en filas
      // nuevas. Sin esto, cada sync re-enable canales que el backfill
      // marcó como sin permiso.
      activo: activoExistente.has(c.jid) ? activoExistente.get(c.jid)! : 1,
    };
  });

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
  // Incluimos activo=0 también — el bug de la sección 2 (lectura
  // incompleta del name) hizo que muchos canales hidratables quedaran
  // marcados como "Not Allowed" → activo=0 por error. Ahora que la
  // extracción de nombre está fixed, los retentamos para reactivarlos.
  const { data, error } = await sb
    .from("wsp_targets")
    .select("jid, activo")
    .eq("user_id", config.userId)
    .eq("tipo", "canal")
    .ilike("nombre", "%sin nombre%");

  if (error) {
    log.warn("backfill: select falló:", error.message);
    return;
  }
  if (!data || data.length === 0) return;

  log.info(`backfill: ${data.length} canales sin nombre → hidratando...`);
  let nOk = 0;
  let nReactivados = 0;
  let nDisabled = 0;
  for (const row of data as Array<{ jid: string; activo: number }>) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sockAny = sock as any;
      const meta = await sockAny.newsletterMetadata("jid", row.jid);
      const { nombre, miembros } = extractNewsletterName(meta);
      if (nombre) {
        const update: Record<string, unknown> = { nombre, miembros };
        if (row.activo === 0) {
          // Estaba desactivado por el bug viejo; ahora se hidrató bien → reactivar.
          update.activo = 1;
          nReactivados++;
        }
        const { error: updErr } = await sb
          .from("wsp_targets")
          .update(update)
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
      // Si el usuario lo quiere realmente, que lo agregue por NEWSLETTER_INVITES.
      if (msg.includes("Not Allowed") || msg.includes("not-allowed")) {
        if (row.activo === 1) {
          const { error: updErr } = await sb
            .from("wsp_targets")
            .update({ activo: 0 })
            .eq("user_id", config.userId)
            .eq("jid", row.jid);
          if (!updErr) nDisabled++;
        }
      }
    }
    await sleep(300);
  }
  log.info(
    `backfill: ${nOk}/${data.length} hidratados (${nReactivados} reactivados), ${nDisabled} marcados inactivos`,
  );
}
