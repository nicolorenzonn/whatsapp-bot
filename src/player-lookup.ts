// Player lookup: dado un número de teléfono entrante (viene con jid tipo
// 5491234567890@s.whatsapp.net), matchea contra casino_jugadores para
// enriquecer con perfil + LTV + segment.
//
// Solo consideramos VIP a los del afiliado 'nicolorenzon2' (958 jugadores,
// confirmado 2026-08-16). El otro afiliado (nicolorenzon1) tiene 18k+ pero
// no se targetea desde el setter — se filtran para NO responderles.

import { sb } from "./supabase.js";
import { log } from "./logger.js";

const VIP_AFILIADO = "nicolorenzon2";

export interface PlayerProfile {
  jugador_id: string;
  nombre: string | null;
  email: string | null;
  telefono: string | null;
  balance: number | null;
  ultimo_login: string | null;
  ultimo_deposito: string | null;
  afiliado: string;
  // Enriquecimiento con GGR histórico
  ltv_apostado: number;
  ltv_ggr: number;
  dias_ultimo_deposito: number | null;
  dias_ultimo_login: number | null;
}

// Segmentación derivada — le pasamos esto a Claude como contexto de alto nivel.
export type PlayerSegment =
  | "vip_activo"       // depósito en últimos 30d
  | "vip_dormido"      // depósito hace 30-90d
  | "vip_frio"         // depósito hace 90+ d o nunca
  | "no_vip"           // afiliado != nicolorenzon2 (ignoramos por ahora)
  | "desconocido";     // teléfono no matchea ningún player

export interface LookupResult {
  segment: PlayerSegment;
  player: PlayerProfile | null;
  telefonoNormalizado: string;
}

// Normaliza el teléfono para matching. WhatsApp da algo tipo
// "5491134567890@s.whatsapp.net"; extraemos solo dígitos.
export function normalizarTelefono(input: string): string {
  return input.replace(/[^\d]/g, "");
}

// Extrae el número de teléfono desde un JID de WhatsApp DM.
// Formato: "<phone>@s.whatsapp.net" — para grupos/canales no aplica.
export function phoneFromJid(jid: string): string | null {
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  return normalizarTelefono(jid.split("@")[0] ?? "");
}

/**
 * Lookup: dado un teléfono, devuelve perfil + segment.
 * Si no matchea ningún jugador → segment='desconocido', player=null.
 * Si matchea pero es de otro afiliado → segment='no_vip', player poblado.
 * Si matchea al afiliado VIP → segment='vip_*' según recencia de depósito.
 */
export async function lookupPlayerByPhone(
  telefonoRaw: string,
): Promise<LookupResult> {
  const telefono = normalizarTelefono(telefonoRaw);
  if (!telefono) {
    return { segment: "desconocido", player: null, telefonoNormalizado: "" };
  }

  // Match tolerante: probamos con el número tal cual y con los últimos 10
  // dígitos (por si hay variaciones de código país guardadas en la DB).
  const last10 = telefono.slice(-10);

  const { data: candidates, error } = await sb
    .from("casino_jugadores")
    .select(
      "jugador_id, nombre, email, telefono, balance, ultimo_login, ultimo_deposito, afiliado",
    )
    .or(`telefono.eq.${telefono},telefono.like.%${last10}`)
    .limit(5);

  if (error) {
    log.error("player-lookup: error consultando casino_jugadores:", error.message);
    return { segment: "desconocido", player: null, telefonoNormalizado: telefono };
  }

  const match = (candidates ?? [])[0]; // primer match — TODO: si hay varios, resolver
  if (!match) {
    return { segment: "desconocido", player: null, telefonoNormalizado: telefono };
  }

  // Enriquecer con GGR histórico agregado
  const { data: ggr } = await sb
    .from("casino_ggr_jugadores")
    .select("total_apostado, total_ggr")
    .eq("jugador_id", match.jugador_id);

  const ltv_apostado = (ggr ?? []).reduce(
    (s, r) => s + (Number(r.total_apostado) || 0),
    0,
  );
  const ltv_ggr = (ggr ?? []).reduce(
    (s, r) => s + (Number(r.total_ggr) || 0),
    0,
  );

  const now = Date.now();
  const dias_ultimo_deposito = match.ultimo_deposito
    ? Math.floor((now - new Date(match.ultimo_deposito).getTime()) / 86_400_000)
    : null;
  const dias_ultimo_login = match.ultimo_login
    ? Math.floor((now - new Date(match.ultimo_login).getTime()) / 86_400_000)
    : null;

  const player: PlayerProfile = {
    jugador_id: match.jugador_id,
    nombre: match.nombre,
    email: match.email,
    telefono: match.telefono,
    balance: match.balance != null ? Number(match.balance) : null,
    ultimo_login: match.ultimo_login,
    ultimo_deposito: match.ultimo_deposito,
    afiliado: match.afiliado,
    ltv_apostado,
    ltv_ggr,
    dias_ultimo_deposito,
    dias_ultimo_login,
  };

  // Segmentación
  let segment: PlayerSegment;
  if (player.afiliado !== VIP_AFILIADO) {
    segment = "no_vip";
  } else if (dias_ultimo_deposito !== null && dias_ultimo_deposito <= 30) {
    segment = "vip_activo";
  } else if (dias_ultimo_deposito !== null && dias_ultimo_deposito <= 90) {
    segment = "vip_dormido";
  } else {
    segment = "vip_frio";
  }

  return { segment, player, telefonoNormalizado: telefono };
}

export function isVipSegment(seg: PlayerSegment): boolean {
  return seg === "vip_activo" || seg === "vip_dormido" || seg === "vip_frio";
}
