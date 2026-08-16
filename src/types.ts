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
  // Pool de URLs para reemplazar {link} en el mensaje. El bot elige una en
  // función del día calendario (rotación cíclica). Si está vacío o el
  // mensaje no contiene {link}, no se hace ningún reemplazo.
  links_json: string[];
  // Si > 0, al calcular next_run desde el cron le sumamos un offset random
  // de [0, jitter_minutes) minutos. Anti-detección: que no caiga todo al
  // mismo segundo. Solo aplica a cron, no a run_at.
  jitter_minutes: number;
  // Categoría libre para agrupar/filtrar (ej: "EBOOK", "CURSO"). NULL = sin
  // categoría. El bot no la usa para nada — es solo para la UI.
  concepto: string | null;
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

// Regla de auto-reenvío canal → comunidad/grupo. Cuando el bot ve un
// mensaje fromMe en source_target_id, lo reenvía a dest_target_id con
// delay random [delay_min_seconds, delay_max_seconds].
export type ForwardMode = "literal" | "ia_rewrite";

export interface WspForward {
  id: number;
  user_id: string;
  source_target_id: number;
  dest_target_id: number;
  enabled: number;
  delay_min_seconds: number;
  delay_max_seconds: number;
  last_forwarded_at: string | null;
  total_forwarded: number;
  created_at: string;
  updated_at: string;
  // literal = reenvía con { forward: msg } (WhatsApp marca "Reenviado").
  // ia_rewrite = pasa por Claude con ia_prompt (o default) y publica el
  // resultado como mensaje nativo, sin etiqueta de reenvío. Útil para
  // curar contenido de canales de terceros con permiso.
  mode: ForwardMode;
  ia_prompt: string | null;
  // Sufijo determinístico que se append al final del mensaje reescrito.
  // NO pasa por Claude (evita paráfrasis / alucinación en disclaimers
  // legales o links de afiliación). Solo se aplica en modo ia_rewrite.
  dest_suffix: string | null;
}
