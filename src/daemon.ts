// Daemon principal del WhatsApp Broadcaster.
//
// Loop:
//   1. Conectar a WhatsApp (reusa creds del pair).
//   2. Sincronizar targets a Supabase (chats / grupos / canales).
//   3. Suscribirse a Supabase Realtime para wsp_tasks (INSERT/UPDATE/DELETE).
//   4. Cada 30s: leer tareas con next_run <= NOW(), ejecutarlas, recalcular
//      next_run (cron-parser) y registrar el run en wsp_runs.
//   5. Cada 60s: heartbeat a wsp_bot_status para que la UI sepa que estamos vivos.
//
// Si el socket se cae: Baileys reconecta solo (ver baileys.ts). Mientras
// está caído, las tareas se acumulan; al volver, las atrasadas se ejecutan
// en orden si pausar_si_offline=1, o se marcan como skipped si =0.

import { CronExpressionParser } from "cron-parser";
import { existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { sb } from "./supabase.js";
import { connect } from "./baileys.js";
import { syncTargets, type ChatStore } from "./sync-targets.js";
import { variarMensaje } from "./rewriter.js";
import { generarFraseDelDia, FRASE_PLACEHOLDER } from "./frase-motivacional.js";
import { startAutoForward, rebindAutoForward, handleTelegramMessage } from "./auto-forward.js";
import { connectTelegram, telegramConfigured } from "./telegram-client.js";
import { syncTelegramTargets } from "./telegram-sync-targets.js";
import { bindDMHandler } from "./dm-handler.js";
import { startHealthzServer, setHealthInfoProvider, setAlertSender } from "./healthz.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { WASocket } from "baileys";
import type { WspTask, WspTarget, WspRunInsert, BotStatus } from "./types.js";

// Wipe del authDir al boot, en dos situaciones:
//
// 1. WSP_FORCE_REPAIR=1 — flag manual del user para forzar re-pair (ej:
//    cuando rotó el cel o quiere parear con otra cuenta).
// 2. Existe `.invalidated` en authDir — flag escrito por baileys.ts cuando
//    WhatsApp tira loggedOut (código 401). Mecanismo self-healing: el
//    daemon anterior detectó que las creds están muertas y dejó esta
//    marca; nosotros wipeamos ANTES de que useMultiFileAuthState las lea
//    de vuelta. Sin esto, entrábamos en crash loop infinito.
//
// Crítico: esto corre ANTES de bootstrapAuth y de connect(). Si esperamos
// a que Baileys cargue las creds malas y tire 401 de nuevo, perdimos un
// ciclo (al menos 60-120s en Railway).
// Signal cross-función: si maybeWipeAuthDir detectó .invalidated y wipeó,
// bootstrapAuth no debe re-inyectar INITIAL_AUTH_B64 (esas creds son las
// MISMAS que WhatsApp acaba de invalidar — cargarlas nos mete en el mismo
// loop 401 → flag → wipe → bootstrap → 401). Se resetea entre boots.
let bootstrapBypassed = false;

function maybeWipeAuthDir() {
  const dir = config.authDir;
  const flag = join(dir, ".invalidated");
  const forceRepair = process.env.WSP_FORCE_REPAIR === "1";
  const hasInvalidatedFlag = existsSync(flag);

  if (!forceRepair && !hasInvalidatedFlag) return;

  if (forceRepair) {
    log.warn("WSP_FORCE_REPAIR=1 → wipeando authDir para forzar re-pairing");
  }
  if (hasInvalidatedFlag) {
    log.warn(".invalidated flag presente → sesión anterior revocada por WhatsApp (401)");
    log.warn("Wipeando authDir antes de cargar Baileys para evitar crash loop");
    // Prevenimos que bootstrapAuth re-inyecte las mismas creds inválidas
    // desde INITIAL_AUTH_B64. Sin este bypass el flow era:
    //   401 → flag → wipe → bootstrap (re-inyecta b64 viejo) → Baileys carga
    //   creds inválidas → 401 → loop.
    bootstrapBypassed = true;
  }

  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
    log.info(`authDir limpiado: ${dir}`);
  } else {
    mkdirSync(dir, { recursive: true });
    log.info(`authDir creado vacío: ${dir}`);
  }

  if (forceRepair) {
    log.info("Sacá WSP_FORCE_REPAIR de Railway después de pairearlo para no wipear en cada deploy.");
  }
}

// Bootstrap desde INITIAL_AUTH_B64 si no hay sesión válida en authDir
// (creds.json es la prueba real de pareo). Si hay archivos sueltos pero
// no creds.json, son basura de pairing-attempts fallidos previos — los
// limpiamos antes de extraer.
function bootstrapAuth() {
  // Si estamos en flujo de force-repair, NUNCA bootstrappear — el intent
  // explícito del user es pairing limpio desde cero. Re-inyectar una
  // sesión vieja (aunque sea válida) saboteaba el flujo.
  if (process.env.WSP_FORCE_REPAIR === "1") {
    log.info("WSP_FORCE_REPAIR=1 → skipeo bootstrapAuth (queremos pairing limpio)");
    return;
  }
  // Si el wipe fue por .invalidated flag, el b64 apunta a la misma sesión
  // que WhatsApp acaba de revocar. Re-inyectarlo nos mete en loop 401 →
  // ver comentario en maybeWipeAuthDir.
  if (bootstrapBypassed) {
    log.info(".invalidated flag detectado → skipeo bootstrapAuth (arranco desde cero para pairing).");
    log.info("Cuando pairees exitosamente, actualizá INITIAL_AUTH_B64 en Railway con las creds nuevas.");
    return;
  }
  const dir = config.authDir;
  if (existsSync(join(dir, "creds.json"))) return;
  const b64 = process.env.INITIAL_AUTH_B64;
  if (!b64) return;
  log.info("Bootstrapping auth desde INITIAL_AUTH_B64 (no se encontró creds.json)...");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
  } else {
    mkdirSync(dir, { recursive: true });
  }
  // Si la b64 está corrupta o el tar falla por cualquier motivo, NO
  // queremos matar el daemon — preferimos seguir con authDir vacío y
  // que el auto-pairing pida un código nuevo. Antes (sin try/catch) un
  // INITIAL_AUTH_B64 corrupto crasheaba el container en loop y Railway
  // nunca lograba healthcheck.
  try {
    const tarPath = "/tmp/initial-auth.tar.gz";
    writeFileSync(tarPath, Buffer.from(b64, "base64"));
    execSync(`tar xzf ${tarPath} --strip-components=1 -C ${dir}`);
    log.info(`Auth bootstrap OK: ${readdirSync(dir).length} archivos en ${dir}`);
  } catch (e) {
    log.warn("INITIAL_AUTH_B64 corrupta o tar inválido — sigo con authDir vacío.");
    log.warn(`Error: ${e instanceof Error ? e.message : e}`);
    log.warn("El auto-pairing va a pedir un código nuevo si WSP_PAIRING_PHONE está seteada.");
    // Aseguramos que authDir exista para que useMultiFileAuthState no falle.
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

let currentSock: WASocket | null = null;
// Flag idempotente: el sistema de auto-forward se inicializa UNA sola vez
// (carga reglas + suscripción Realtime + handler). En reconexiones
// posteriores solo re-engancha el handler al nuevo sock.
let autoForwardStarted = false;

// In-memory store de todos los chats que Baileys nos avisó (en
// messaging-history.set + chats.upsert/update). Lo usamos para descubrir
// canales (@newsletter) que no aparecen en groupFetchAllParticipating.
const chatStore: ChatStore = new Map();

const TICK_MS = 30_000;
const HEARTBEAT_MS = 60_000;

// ── Heartbeat ─────────────────────────────────────────────────────────────
async function heartbeat(numero: string | null) {
  await sb.from("wsp_bot_status").upsert({
    user_id: config.userId,
    status: currentSock ? "connected" : "disconnected",
    numero,
    ultimo_heartbeat: new Date().toISOString(),
    bot_version: config.botVersion,
    error: null,
  });
}

// ── Rotación de links por día ─────────────────────────────────────────────
// Si la task tiene links_json no vacío y el mensaje contiene {link},
// elegimos uno en función del día calendario en Argentina (rotación cíclica
// estable: el mismo día → mismo link).
const TZ_AR = "America/Argentina/Buenos_Aires";

function pickLinkOfDay(links: string[], at: Date = new Date()): string {
  // "YYYY-MM-DD" en zona AR → número entero estable.
  const ymd = at.toLocaleDateString("en-CA", { timeZone: TZ_AR });
  const dayNum = Number(ymd.replaceAll("-", ""));
  return links[dayNum % links.length]!;
}

function aplicarLinkDelDia(mensaje: string, links: string[]): string {
  if (!links || links.length === 0) return mensaje;
  if (!mensaje.includes("{link}")) return mensaje;
  const link = pickLinkOfDay(links);
  return mensaje.replaceAll("{link}", link);
}

// ── Cálculo del próximo next_run ──────────────────────────────────────────
function calcNextRun(task: WspTask, fromDate: Date = new Date()): Date | null {
  if (task.cron) {
    try {
      const it = CronExpressionParser.parse(task.cron, {
        currentDate: fromDate,
        tz: task.tz,
      });
      const base = it.next().toDate();
      // Jitter: si jitter_minutes > 0, sumamos un offset random [0, N min).
      // Que el cron sea la hora "early bound" y el envío caiga en algún
      // momento dentro de la ventana — anti-detección por regularidad.
      const jitter = task.jitter_minutes ?? 0;
      if (jitter > 0) {
        const offsetMs = Math.floor(Math.random() * jitter * 60_000);
        return new Date(base.getTime() + offsetMs);
      }
      return base;
    } catch (e) {
      log.warn(`Cron inválido en task ${task.id}: ${task.cron}`, e);
      return null;
    }
  }
  if (task.run_at) {
    const at = new Date(task.run_at);
    return at > fromDate ? at : null;
  }
  return null;
}

// ── Ejecución de una tarea ────────────────────────────────────────────────
async function ejecutarTask(task: WspTask, target: WspTarget): Promise<void> {
  const scheduledAt = task.next_run ?? new Date().toISOString();

  // Si el bot está offline:
  if (!currentSock) {
    if (task.pausar_si_offline === 0) {
      // Política: skip silencioso.
      const run: WspRunInsert = {
        user_id: config.userId,
        task_id: task.id,
        target_id: task.target_id,
        scheduled_at: scheduledAt,
        status: "skipped",
        error: "Bot desconectado al momento del envío",
      };
      await sb.from("wsp_runs").insert(run);
      log.warn(`[${task.nombre}] skipped (offline + pausar_si_offline=0)`);
    } else {
      // pausar_si_offline=1 → no hacemos nada acá; el próximo tick lo retoma.
      log.info(`[${task.nombre}] postergado (offline)`);
    }
    return;
  }

  // 1) Reemplazo del placeholder {{FRASE_DEL_DIA}} con la frase motivacional
  //    generada por Claude (cacheada por taskId+día). Si el mensaje no lo
  //    contiene, es no-op.
  let mensajeBase = task.mensaje;
  const tieneFrase = mensajeBase.includes(FRASE_PLACEHOLDER);
  if (tieneFrase) {
    const frase = await generarFraseDelDia(task.id, task.tz);
    mensajeBase = mensajeBase.split(FRASE_PLACEHOLDER).join(frase);
  }

  // 2) Reemplazo del placeholder {link} con el link del día (si hay pool).
  //    Hacemos esto ANTES del rewriter para que la URL final ya esté en el
  //    texto y la IA la preserve byte por byte (regla del system prompt).
  const mensajeConLink = aplicarLinkDelDia(mensajeBase, task.links_json ?? []);

  // 3) Variar mensaje con IA si corresponde. Cacheado por (task, día):
  //    si la task corre varias veces en el mismo día, reusa la misma variante.
  //    Si la tarea usó {{FRASE_DEL_DIA}}, FORZAMOS variar_con_ia=0 — la frase
  //    ya es la "variante" del día y el rewriter rompería la cita literal.
  const mensajeFinal = task.variar_con_ia === 1 && !tieneFrase
    ? await variarMensaje(mensajeConLink, task.id, task.tz)
    : mensajeConLink;

  let runStatus: "ok" | "error" = "ok";
  let errorMsg: string | undefined;
  let wspMessageId: string | undefined;

  try {
    // Anti-detección: simular "tipeando" antes de mandar. WhatsApp Web/cliente
    // oficial siempre publica presence "composing" mientras el usuario tipea
    // y "paused" al terminar — un send sin presencia previa es la firma más
    // común de un bot. Hacemos 800-2200ms de "tipeando" + cierre con "paused".
    // Para grupos/canales no aplica (los demás miembros igual no ven typing
    // suyo si no estás interactuando), pero no rompe nada igual.
    const typingMs = 800 + Math.floor(Math.random() * 1400);
    try {
      await currentSock.sendPresenceUpdate("composing", target.jid);
      await sleep(typingMs);
      await currentSock.sendPresenceUpdate("paused", target.jid);
    } catch {
      // Si presence falla (algunos targets no la aceptan), seguimos igual.
    }

    const result = await currentSock.sendMessage(target.jid, { text: mensajeFinal });
    wspMessageId = result?.key?.id ?? undefined;
    log.info(`[${task.nombre}] → ${target.nombre} (${target.tipo}) ✓ msgId=${wspMessageId ?? "?"}`);
  } catch (e) {
    runStatus = "error";
    errorMsg = e instanceof Error ? e.message : String(e);
    log.error(`[${task.nombre}] falló: ${errorMsg}`);
  }

  // Registrar el run.
  const run: WspRunInsert = {
    user_id: config.userId,
    task_id: task.id,
    target_id: task.target_id,
    scheduled_at: scheduledAt,
    ejecutada_en: new Date().toISOString(),
    status: runStatus,
    mensaje_final: mensajeFinal,
    error: errorMsg,
    wsp_message_id: wspMessageId,
  };
  await sb.from("wsp_runs").insert(run);

  // Auto-pause: si la task viene fallando con "forbidden" repetidos, la
  // pauseamos. WhatsApp acumula señales de spam con cada send rechazado,
  // y un cron que dispara cada hora a un grupo donde no podés mandar
  // suma sin sentido. El owner reactiva manualmente en /tasks cuando
  // tenga acceso de vuelta.
  if (runStatus === "error" && esErrorPermanentePush(errorMsg)) {
    await maybeAutoPause(task.id, task.nombre);
  }

  // Calcular próxima ejecución (o limpiar si fue one-shot).
  const next = calcNextRun(task, new Date());
  await sb
    .from("wsp_tasks")
    .update({ next_run: next?.toISOString() ?? null })
    .eq("id", task.id);
}

// Errores que indican que el destino NO va a aceptar más mensajes hasta
// que algo cambie (no es transitorio). Los otros (timeouts, network, etc.)
// los reintentamos al próximo cron.
function esErrorPermanentePush(msg: string | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes("forbidden") ||         // bot kickeado / canal no permite
    m.includes("not-allowed") ||
    m.includes("not authorized") ||
    m.includes("user not in group") ||
    m.includes("recipient not found")
  );
}

// Pausa una task si tiene N=3 fallos PERMANENTES consecutivos (sin ningún
// ok entre medio). Idempotente: si ya estaba pausada o no llegó al umbral,
// no hace nada.
const AUTO_PAUSE_THRESHOLD = 3;
async function maybeAutoPause(taskId: number, taskNombre: string): Promise<void> {
  const { data: ultimos, error } = await sb
    .from("wsp_runs")
    .select("status, error")
    .eq("task_id", taskId)
    .eq("user_id", config.userId)
    .order("ejecutada_en", { ascending: false })
    .limit(AUTO_PAUSE_THRESHOLD);
  if (error) {
    log.warn(`[auto-pause] no pude leer wsp_runs de task ${taskId}: ${error.message}`);
    return;
  }
  if (!ultimos || ultimos.length < AUTO_PAUSE_THRESHOLD) return;
  const todosFail = ultimos.every(
    (r) => r.status === "error" && esErrorPermanentePush(r.error ?? undefined),
  );
  if (!todosFail) return;
  const { error: updErr } = await sb
    .from("wsp_tasks")
    .update({ pausada: 1 })
    .eq("id", taskId)
    .eq("user_id", config.userId);
  if (updErr) {
    log.warn(`[auto-pause] update falló para task ${taskId}: ${updErr.message}`);
    return;
  }
  log.warn(
    `[auto-pause] task "${taskNombre}" (id=${taskId}) PAUSADA — ${AUTO_PAUSE_THRESHOLD} fallos permanentes seguidos. Reactivá manualmente en /tasks cuando recuperes acceso al destino.`,
  );
}

// Helper local — el global vive en sync-targets.ts pero no lo exportan.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Tick: leer tareas vencidas y ejecutarlas en orden ─────────────────────
let tickInFlight = false;
async function tick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const nowIso = new Date().toISOString();

    const { data: tasks, error } = await sb
      .from("wsp_tasks")
      .select("*")
      .eq("user_id", config.userId)
      .eq("bot_mode", config.botMode)
      .eq("pausada", 0)
      .not("next_run", "is", null)
      .lte("next_run", nowIso)
      .order("next_run", { ascending: true })
      .limit(20);

    if (error) {
      log.error("Error leyendo tasks:", error.message);
      return;
    }
    if (!tasks || tasks.length === 0) return;

    log.debug(`Tick: ${tasks.length} tareas vencidas para ejecutar`);

    // Cargar targets de esas tasks de una.
    const targetIds = [...new Set(tasks.map((t) => t.target_id))];
    const { data: targets } = await sb
      .from("wsp_targets")
      .select("*")
      .eq("user_id", config.userId)
      .in("id", targetIds);

    const byId = new Map<number, WspTarget>(
      (targets ?? []).map((t) => [t.id, t as WspTarget]),
    );

    let nProcesadas = 0;
    for (const task of tasks as WspTask[]) {
      // Anti-detección: entre cada send del mismo tick, esperar un random
      // 1.5-4s. Si caen 5 tasks al mismo minuto, distribuir los envíos en
      // vez de back-to-back. Solo aplica del 2do en adelante (la primera
      // sale al toque).
      if (nProcesadas > 0) {
        const gap = 1500 + Math.floor(Math.random() * 2500);
        await sleep(gap);
      }
      const target = byId.get(task.target_id);
      if (!target) {
        log.warn(`Task ${task.id} apunta a target_id ${task.target_id} inexistente`);
        await sb
          .from("wsp_runs")
          .insert({
            user_id: config.userId,
            task_id: task.id,
            target_id: task.target_id,
            scheduled_at: task.next_run ?? new Date().toISOString(),
            status: "error",
            error: "target inexistente",
          } satisfies WspRunInsert);
        // Avanzar el next_run igual para que no quede en loop.
        const next = calcNextRun(task);
        await sb
          .from("wsp_tasks")
          .update({ next_run: next?.toISOString() ?? null })
          .eq("id", task.id);
        continue;
      }
      await ejecutarTask(task, target);
      nProcesadas++;
    }
  } finally {
    tickInFlight = false;
  }
}

// Variante tolerante de calcNextRun para tasks que acaban de insertarse o
// actualizarse (no para el path post-ejecución). Acepta run_at levemente en
// el pasado (últimos 5 min) — caso típico: integraciones que insertan con
// run_at=NOW(), donde por milisegundos ya pasó cuando lo procesamos por
// Realtime. Para cron, idéntico a calcNextRun. Si run_at es muy viejo
// (>5min en el pasado), devuelve null y la task queda como expirada.
const RUN_AT_GRACE_MS = 5 * 60_000;
function calcNextRunOnInsert(task: WspTask, fromDate: Date = new Date()): Date | null {
  if (task.cron) return calcNextRun(task, fromDate);
  if (task.run_at) {
    const at = new Date(task.run_at);
    const elapsed = fromDate.getTime() - at.getTime();
    if (elapsed < 0) return at;                // run_at en el futuro → ok
    if (elapsed < RUN_AT_GRACE_MS) return at;  // run_at recién pasado → ok, ejecutar ya
    return null;                                // run_at viejo (>5min) → expirado
  }
  return null;
}

// ── Recalcular next_run cuando una task se inserta o cambia ───────────────
async function refreshNextRunFor(taskId: number): Promise<void> {
  const { data, error } = await sb
    .from("wsp_tasks")
    .select("*")
    .eq("id", taskId)
    .eq("user_id", config.userId)
    .eq("bot_mode", config.botMode)
    .single();
  if (error || !data) return;
  const task = data as WspTask;
  // Si la task no tiene next_run o quedó en el pasado, recalcular desde ahora.
  const stale = !task.next_run || new Date(task.next_run) < new Date();
  if (!stale) return;
  const next = calcNextRunOnInsert(task, new Date());
  await sb
    .from("wsp_tasks")
    .update({ next_run: next?.toISOString() ?? null })
    .eq("id", taskId);
  log.debug(`task ${taskId} next_run recalculado → ${next?.toISOString() ?? "null"}`);
}

// ── Suscripción Realtime a cambios en wsp_tasks ───────────────────────────
function suscribirRealtime(): void {
  const channel = sb
    .channel("wsp-tasks-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "wsp_tasks", filter: `user_id=eq.${config.userId}` },
      (payload) => {
        if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
          const id = (payload.new as { id?: number }).id;
          if (id) void refreshNextRunFor(id);
        }
      },
    )
    .subscribe((status) => {
      log.debug(`Realtime channel status: ${status}`);
    });
  // mantener vivo
  void channel;
}

// ── Boot ──────────────────────────────────────────────────────────────────
async function main() {
  log.info(`WhatsApp Broadcaster Bot v${config.botVersion} arrancando...`);
  log.info(`User ID: ${config.userId}`);

  // ORDEN IMPORTANTE:
  //   1. maybeWipeAuthDir — chequea WSP_FORCE_REPAIR y el flag .invalidated
  //      escrito por baileys.ts cuando WhatsApp tira loggedOut. Wipea el
  //      authDir antes de que NADIE más lo toque.
  //   2. bootstrapAuth — solo si NO hay creds.json (después del wipe está
  //      vacío). Si hay INITIAL_AUTH_B64 lo extrae.
  //   3. connect() — Baileys lee con useMultiFileAuthState. Si el authDir
  //      está vacío después de los pasos previos, arranca pairing.
  maybeWipeAuthDir();
  bootstrapAuth();

  // Healthz HTTP server — para que Railway haga healthchecks contra el
  // proceso. Devuelve 200 si Baileys está conectado, 503 si no.
  setHealthInfoProvider(() => ({
    status: (currentSock ? "connected" : "disconnected") as BotStatus,
    numero: currentSock?.user?.id?.split(":")[0]?.split("@")[0] ?? null,
  }));
  startHealthzServer();

  await sb.from("wsp_bot_status").upsert({
    user_id: config.userId,
    status: "disconnected",
    bot_version: config.botVersion,
    ultimo_heartbeat: new Date().toISOString(),
  });

  const bootSock = await connect({
    printQR: false,
    // Si no hay creds Y tenemos pairingPhone, baileys.ts pide el pairing
    // code INMEDIATAMENTE después de makeWASocket (antes que entre en QR
    // mode) y lo regenera cada 65s hasta conectarse.
    pairingPhone: config.pairingPhone,
    onReady: async (sock) => {
      currentSock = sock;
      const numero = sock.user?.id?.split(":")[0]?.split("@")[0] ?? null;

      // Habilitar endpoint POST /alert ahora que tenemos un socket vivo.
      // El handler de healthz lo usa para mandar DMs cuando GH Actions
      // notifica fallos del scraper. Se setea null en `close` event abajo.
      setAlertSender((jid, text) => sock.sendMessage(jid, { text }));

      await heartbeat(numero);

      // Acumular chats vistos (incluye newsletters/canales) — Baileys los
      // avisa por estos eventos. El store crece a medida que la sesión se
      // hidrata; se reinicia si reiniciás el daemon.
      sock.ev.on("messaging-history.set", (ev) => {
        const chats = (ev as unknown as { chats?: unknown[] }).chats ?? [];
        for (const c of chats) {
          const chat = c as { id?: string; name?: string; subject?: string };
          if (chat.id) chatStore.set(chat.id, { id: chat.id, name: chat.name, subject: chat.subject });
        }
        log.debug(`messaging-history.set: +${chats.length} chats (total: ${chatStore.size})`);
      });
      sock.ev.on("chats.upsert", (chats) => {
        for (const c of chats as unknown as Array<{ id: string; name?: string; subject?: string }>) {
          if (c.id) chatStore.set(c.id, { id: c.id, name: c.name, subject: c.subject });
        }
      });
      sock.ev.on("chats.update", (updates) => {
        for (const u of updates as unknown as Array<{ id?: string; name?: string; subject?: string }>) {
          if (!u.id) continue;
          const prev = chatStore.get(u.id);
          chatStore.set(u.id, { id: u.id, name: u.name ?? prev?.name, subject: u.subject ?? prev?.subject });
        }
      });

      // Sync inicial de targets — 8s después para dejar que Baileys termine
      // de hidratar la lista de chats (newsletters demoran un poco más que
      // grupos en aparecer en messaging-history.set).
      setTimeout(() => {
        void syncTargets(sock, chatStore).catch((e) =>
          log.error("Sync targets falló:", e instanceof Error ? e.message : e),
        );
      }, 8_000);

      // Setter casino: escucha DMs directos y persiste conversaciones. Si
      // SETTER_ENABLED=1 además genera drafts IA en modo shadow para VIPs.
      // Se re-engancha en cada reconexión (idempotente — solo registra listener).
      bindDMHandler(sock);

      // Auto-reenvío canal → comunidad. La primera vez (autoForwardStarted=false)
      // arranca el sistema entero (carga reglas + suscripción a Realtime +
      // handler de mensajes). En reconexiones posteriores solo re-engancha el
      // handler al nuevo sock para no duplicar la suscripción a Realtime.
      if (!autoForwardStarted) {
        autoForwardStarted = true;
        void startAutoForward(sock).catch((e) =>
          log.error("auto-forward: start falló:", e instanceof Error ? e.message : e),
        );

        // ── Telegram client (opcional, dispara pipeline auto-forward tmb) ──
        // Se activa SOLO si TELEGRAM_API_ID + HASH + SESSION están seteados.
        // Si falla, WhatsApp sigue funcionando sin ningún impacto (try/catch
        // aísla cualquier crash del cliente Telegram del resto del daemon).
        if (telegramConfigured()) {
          void (async () => {
            try {
              const tgClient = await connectTelegram((evt) => {
                // Bridge: cada mensaje Telegram entrante dispara el mismo
                // pipeline que WhatsApp. getSock permite que el handler use
                // el sock actual (puede haber sido swapped por reconexión).
                handleTelegramMessage(() => currentSock, {
                  sourceJid: evt.sourceJid,
                  sourceName: evt.sourceName,
                  text: evt.text,
                });
              });
              if (tgClient) {
                // Sync inicial + periódico de canales Telegram a wsp_targets.
                setTimeout(() => void syncTelegramTargets().catch(() => {}), 5_000);
                setInterval(() => void syncTelegramTargets().catch(() => {}), 15 * 60_000);
              }
            } catch (e) {
              log.error(
                "telegram: bootstrap falló (ignorado, WhatsApp sigue OK):",
                e instanceof Error ? e.message : e,
              );
            }
          })();
        } else {
          log.info(
            "telegram: config incompleta — feature deshabilitada (solo WhatsApp activo)",
          );
        }
      } else {
        rebindAutoForward(sock);
      }

      // Re-sync periódico cada 10 min para reflejar nuevos chats/canales.
      setInterval(() => {
        if (currentSock) void syncTargets(currentSock, chatStore).catch(() => {});
      }, 10 * 60_000);

      // Setear listener de desconexión (lo manejamos en baileys.ts pero
      // queremos limpiar currentSock acá para que el tick sepa).
      sock.ev.on("connection.update", (u) => {
        if (u.connection === "close") currentSock = null;
        if (u.connection === "open") currentSock = sock;
      });
    },
  });

  // Nota: el flow de pairing code ahora vive enteramente en baileys.ts
  // connect() (se dispara inmediatamente post-makeWASocket cuando no hay
  // creds + pairingPhone seteado). Antes el daemon hacía un setTimeout(4s)
  // pero llegaba tarde — Baileys ya había entrado en QR mode y los códigos
  // generados eran inválidos. Ahora pasamos pairingPhone via ConnectOptions
  // y baileys.ts hace todo (request + retry loop + cleanup en "open").

  // Suscripción a cambios y loop de tick.
  suscribirRealtime();
  setInterval(() => void tick(), TICK_MS);
  setInterval(() => {
    const numero = currentSock?.user?.id?.split(":")[0]?.split("@")[0] ?? null;
    void heartbeat(numero);
  }, HEARTBEAT_MS);

  // Primer tick inmediato (después de los 5s del sync inicial).
  setTimeout(() => void tick(), 8_000);

  log.info("Daemon listo. Esperando tareas...");
}

main().catch((e) => {
  log.error("Daemon fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});

// Salida limpia con Ctrl+C.
process.on("SIGINT", async () => {
  log.info("SIGINT — cerrando...");
  await sb.from("wsp_bot_status").upsert({
    user_id: config.userId,
    status: "disconnected",
    ultimo_heartbeat: new Date().toISOString(),
  });
  process.exit(0);
});
