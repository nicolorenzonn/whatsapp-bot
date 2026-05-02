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
  // Vienen del chatStore que pobla el daemon a partir de eventos. No tienen
  // info de members en el evento — la dejamos en null. Si en el futuro
  // queremos count exacto, hay que llamar a sock.newsletterMetadata(jid) por
  // cada uno, pero es N requests y la mayoría devuelve métricas distintas.
  let nCanales = 0;
  for (const c of chatStore.values()) {
    if (!c.id?.endsWith("@newsletter")) continue;
    if (seen.has(c.id)) continue;
    rows.push({
      jid: c.id,
      tipo: "canal",
      nombre: c.name || c.subject || "(canal sin nombre)",
      miembros: null,
    });
    seen.add(c.id);
    nCanales++;
  }
  log.debug(`chatStore → ${nCanales} canales (newsletters) descubiertos`);

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
  return chats.length;
}
