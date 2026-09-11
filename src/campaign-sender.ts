// Campaign sender: procesa broadcasts masivos a wsp_campaign_leads.
//
// Flujo por tick (cada 60s):
//   1. Buscar campañas con status='active'.
//   2. Para cada campaña:
//      - Verificar hora hábil (hour_start..hour_end en tz)
//      - Contar cuántos ya se mandaron hoy (sent_at::date = hoy)
//      - Si sent_today >= daily_cap → skip la campaña esta iteración
//      - Verificar consecutive_errors < auto_pause_on_errors
//      - Agarrar 1 lead pending
//      - Marcar como 'sending' (evita duplicados en próximo tick)
//      - Componer mensaje (reemplazar {nombre} + rewriter opcional)
//      - Enviar vía Baileys
//      - Update status='sent' o 'error'
//   3. Después de cada envío, esperar jitter random [jitter_min, jitter_max] antes
//      del próximo lead de la MISMA campaña. Distintas campañas corren en paralelo.
//
// Anti-detección:
//   - Rewriter reformula sutilmente cada mensaje (link preservado byte-por-byte)
//   - Jitter random entre envíos evita patrón "cada X segundos exacto"
//   - Hora hábil filtra madrugada
//   - Auto-pause al detectar N errores seguidos (posible ban temprano)

import type { WASocket } from "baileys";
import { sb } from "./supabase.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { variarMensaje } from "./rewriter.js";

interface Campaign {
  id: number;
  nombre: string;
  mensaje_base: string;
  link_preservar: string | null;
  status: string;
  daily_cap: number;
  hour_start: number;
  hour_end: number;
  tz: string;
  jitter_seconds_min: number;
  jitter_seconds_max: number;
  auto_pause_on_errors: number;
  variar_con_ia: number;
  media_url: string | null;
  consecutive_errors: number;
}

interface Lead {
  id: number;
  campaign_id: number;
  nombre: string | null;
  telefono: string;
  jid: string;
  intentos: number;
}

// State in-memory: cuándo fue el último envío por campaign, para respetar
// jitter entre leads de la misma campaña.
const lastSendPerCampaign = new Map<number, number>();

function nowInTz(tz: string): { hour: number; dateISO: string } {
  const date = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const h = parts.find((p) => p.type === "hour")!.value;
  return { hour: parseInt(h, 10), dateISO: `${y}-${m}-${d}` };
}

function jitterMs(min: number, max: number): number {
  const span = Math.max(0, max - min);
  return (min + Math.floor(Math.random() * (span + 1))) * 1000;
}

async function pickPendingLead(campaignId: number): Promise<Lead | null> {
  // Agarra un lead pending random (evita orden estricto → más humano).
  // Uso OFFSET random como aproximación — con miles de leads es OK.
  const { data: count } = await sb
    .from("wsp_campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "pending");
  const total = (count as unknown as { count?: number })?.count ?? 0;
  if (total === 0) return null;
  const offset = Math.floor(Math.random() * total);
  const { data } = await sb
    .from("wsp_campaign_leads")
    .select("id, campaign_id, nombre, telefono, jid, intentos")
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .range(offset, offset)
    .limit(1);
  return (data?.[0] as Lead) ?? null;
}

// Marca lead como 'sending' de forma atómica (CAS con status='pending' →
// 'sending'). Si otro tick ya lo tomó, este UPDATE afecta 0 rows y skipeamos.
async function claimLead(leadId: number): Promise<boolean> {
  const { data } = await sb
    .from("wsp_campaign_leads")
    .update({ status: "sending" })
    .eq("id", leadId)
    .eq("status", "pending")
    .select("id");
  return (data?.length ?? 0) > 0;
}

async function countSentToday(campaignId: number, dateISO: string): Promise<number> {
  const { count } = await sb
    .from("wsp_campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "sent")
    .gte("sent_at", `${dateISO}T00:00:00`)
    .lt("sent_at", `${dateISO}T23:59:59`);
  return count ?? 0;
}

function componerMensaje(camp: Campaign, lead: Lead): string {
  // Reemplaza {nombre} — si no hay nombre, usa "" (queda "Hola !" que igual va).
  const primerNombre = (lead.nombre || "").split(" ")[0] || "";
  return camp.mensaje_base.replaceAll("{nombre}", primerNombre);
}

async function procesarCampania(sock: WASocket, camp: Campaign): Promise<void> {
  const { hour, dateISO } = nowInTz(camp.tz);

  // Hora hábil
  if (hour < camp.hour_start || hour >= camp.hour_end) {
    return;
  }

  // Respetar jitter entre leads de la misma campaña
  const lastSend = lastSendPerCampaign.get(camp.id) ?? 0;
  const targetGap = jitterMs(camp.jitter_seconds_min, camp.jitter_seconds_max);
  const timeSinceLast = Date.now() - lastSend;
  if (lastSend > 0 && timeSinceLast < targetGap) {
    return; // aún no toca
  }

  // Cap diario
  const sentToday = await countSentToday(camp.id, dateISO);
  if (sentToday >= camp.daily_cap) {
    return;
  }

  // Auto-pause si demasiados errores seguidos
  if (camp.consecutive_errors >= camp.auto_pause_on_errors) {
    log.warn(
      `campaign ${camp.id}: ${camp.consecutive_errors} errores seguidos → auto-pause`,
    );
    await sb
      .from("wsp_campaigns")
      .update({ status: "paused" })
      .eq("id", camp.id);
    return;
  }

  // Buscar lead pending
  const lead = await pickPendingLead(camp.id);
  if (!lead) {
    // No hay más leads → marcar campaña como 'completed'
    log.info(`campaign ${camp.id}: sin más leads pending → completed`);
    await sb
      .from("wsp_campaigns")
      .update({ status: "completed" })
      .eq("id", camp.id);
    return;
  }

  // Claim atómico
  const claimed = await claimLead(lead.id);
  if (!claimed) {
    return; // otro tick lo tomó
  }

  lastSendPerCampaign.set(camp.id, Date.now());

  const mensajeBase = componerMensaje(camp, lead);
  let mensajeFinal = mensajeBase;

  // Rewriter opcional — reformula levemente para variar entre envíos.
  if (camp.variar_con_ia === 1) {
    try {
      mensajeFinal = await variarMensaje(mensajeBase, camp.id, camp.tz);
    } catch (e) {
      log.warn(
        `campaign ${camp.id} rewriter falló (uso base):`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Enviar
  let error: string | null = null;
  let wspId: string | null = null;
  try {
    const result = await sock.sendMessage(lead.jid, { text: mensajeFinal });
    wspId = result?.key?.id ?? null;
    log.info(
      `campaign ${camp.id} → ${lead.jid} ("${(lead.nombre ?? "").slice(0, 30)}") ✓`,
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    log.error(`campaign ${camp.id} → ${lead.jid} error: ${error}`);
  }

  // Update lead
  if (error) {
    await sb
      .from("wsp_campaign_leads")
      .update({
        status: "error",
        error,
        intentos: lead.intentos + 1,
      })
      .eq("id", lead.id);
    // Sumar consecutive_errors
    await sb
      .from("wsp_campaigns")
      .update({
        consecutive_errors: camp.consecutive_errors + 1,
        total_errors: camp.consecutive_errors + 1,
      })
      .eq("id", camp.id);
  } else {
    await sb
      .from("wsp_campaign_leads")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        mensaje_final: mensajeFinal,
        wsp_message_id: wspId,
        intentos: lead.intentos + 1,
      })
      .eq("id", lead.id);
    // Reset consecutive_errors + sumar total_sent (sin RPC — update simple)
    await sb
      .from("wsp_campaigns")
      .update({
        consecutive_errors: 0,
        last_sent_at: new Date().toISOString(),
      })
      .eq("id", camp.id);
    // total_sent con select+update
    const { data: cur } = await sb
      .from("wsp_campaigns")
      .select("total_sent")
      .eq("id", camp.id)
      .single();
    if (cur) {
      await sb
        .from("wsp_campaigns")
        .update({ total_sent: (cur.total_sent ?? 0) + 1 })
        .eq("id", camp.id);
    }
  }
}

let tickInFlight = false;
async function tick(sock: WASocket): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const { data: campaigns, error } = await sb
      .from("wsp_campaigns")
      .select("*")
      .eq("user_id", config.userId)
      .eq("status", "active");
    if (error) {
      log.error("campaign-sender: error leyendo campaigns:", error.message);
      return;
    }
    if (!campaigns || campaigns.length === 0) return;

    // Procesar campañas en paralelo pero cada una con su propio pacing
    await Promise.all(
      (campaigns as Campaign[]).map((c) =>
        procesarCampania(sock, c).catch((e) =>
          log.error(
            `campaign ${c.id} procesamiento falló:`,
            e instanceof Error ? e.message : e,
          ),
        ),
      ),
    );
  } finally {
    tickInFlight = false;
  }
}

const CAMPAIGN_TICK_MS = 60_000; // 1 minuto

let started = false;
export function startCampaignSender(getSock: () => WASocket | null): void {
  if (started) return;
  started = true;
  setInterval(() => {
    const sock = getSock();
    if (!sock) return;
    void tick(sock);
  }, CAMPAIGN_TICK_MS);
  log.info(`campaign-sender: tick cada ${CAMPAIGN_TICK_MS / 1000}s`);
}
