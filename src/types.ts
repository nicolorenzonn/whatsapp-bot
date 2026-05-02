// Tipos espejo de las tablas wsp_* (ver supabase/migrations/0013).
// No es el shape exacto de Postgres — convertimos snake_case y omitimos
// columnas que no usamos en el bot.

export type TargetTipo = "canal" | "grupo" | "comunidad" | "dm";

export interface WspTarget {
  id: number;
  user_id: string;
  jid: string;
  tipo: TargetTipo;
  nombre: string;
  miembros: number | null;
  avatar: string | null;
  last_seen: string;
  activo: number;
  notas: string | null;
}

export type RunStatus = "ok" | "error" | "skipped" | "retry";

export interface WspTask {
  id: number;
  user_id: string;
  target_id: number;
  nombre: string;
  mensaje: string;
  attachments_json: unknown[];
  cron: string | null;
  run_at: string | null;
  tz: string;
  next_run: string | null;
  pausada: number;
  variar_con_ia: number;
  pausar_si_offline: number;
}

export interface WspRunInsert {
  user_id: string;
  task_id: number;
  target_id: number;
  scheduled_at: string;
  ejecutada_en?: string;
  status: RunStatus;
  mensaje_final?: string;
  error?: string;
  wsp_message_id?: string;
}

export type BotStatus = "connected" | "disconnected" | "pairing" | "error";
