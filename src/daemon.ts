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
import { startHealthzServer, setHealthInfoProvider } from "./healthz.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { WASocket } from "baileys";
import type { WspTask, WspTarget, WspRunInsert, BotStatus } from "./types.js";

// Bootstrap desde INITIAL_AUTH_B64 si no hay sesión válida en authDir
// (creds.json es la prueba real de pareo). Si hay archivos sueltos pero
// no creds.json, son basura de pairing-attempts fallidos previos — los
// limpiamos antes de extraer.
function bootstrapAuth() {
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
  const tarPath = "/tmp/initial-auth.tar.gz";
  writeFileSync(tarPath, Buffer.from(b64, "base64"));
  execSync(`tar xzf ${tarPath} --strip-components=1 -C ${dir}`);
  log.info(`Auth bootstrap OK: ${readdirSync(dir).length} archivos en ${dir}`);
}

let currentSock: WASocket | null = null;

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

  // 1) Reemplazo del placeholder {link} con el link del día (si hay pool).
  //    Hacemos esto ANTES del rewriter para que la URL final ya esté en el
  //    texto y la IA la preserve byte por byte (regla del system prompt).
  const mensajeConLink = aplicarLinkDelDia(task.mensaje, task.links_json ?? []);

  // 2) Variar mensaje con IA si corresponde. Cacheado por (task, día):
  //    si la task corre varias veces en el mismo día, reusa la misma variante.
  const mensajeFinal = task.variar_con_ia === 1
    ? await variarMensaje(mensajeConLink, task.id, task.tz)
    : mensajeConLink;

  let runStatus: "ok" | "error" = "ok";
  let errorMsg: string | undefined;
  let wspMessageId: string | undefined;

  try {
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

  // Calcular próxima ejecución (o limpiar si fue one-shot).
  const next = calcNextRun(task, new Date());
  await sb
    .from("wsp_tasks")
    .update({ next_run: next?.toISOString() ?? null })
    .eq("id", task.id);
}

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

    for (const task of tasks as WspTask[]) {
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
    onReady: async (sock) => {
      currentSock = sock;
      const numero = sock.user?.id?.split(":")[0]?.split("@")[0] ?? null;

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

  // ── Auto-pairing si no hay sesión ────────────────────────────────────────
  // Cuando corremos en Railway / cloud, no hay un paso manual de `npm run
  // pair`. Si Baileys arranca sin creds registradas Y tenemos
  // WSP_PAIRING_PHONE seteada, pedimos el pairing code automáticamente
  // al arrancar y lo imprimimos bien grande en logs. El user lo lee desde
  // Railway → Deployments → ver logs y lo entra en su celular.
  setTimeout(async () => {
    // Si ya estamos conectados (sock tiene user asignado) o creds ya
    // registradas, NO pedimos pairing — pedirlo encima de una sesión
    // activa hace que WhatsApp tire 503 → 401 y nos revoca la sesión.
    if (currentSock?.user || bootSock.user || bootSock.authState.creds.registered) return;
    if (!config.pairingPhone) {
      log.warn("Sin sesión guardada y sin WSP_PAIRING_PHONE configurado.");
      log.warn("Setea WSP_PAIRING_PHONE en Variables (número internacional sin '+')");
      log.warn("y redeployá para que aparezca el pairing code acá.");
      return;
    }
    try {
      const code = await bootSock.requestPairingCode(config.pairingPhone);
      const formatted = code.match(/.{1,4}/g)?.join("-") ?? code;
      log.info("");
      log.info("════════════════════════════════════════════════════");
      log.info(`  PAIRING CODE: ${formatted}`);
      log.info("");
      log.info("  En tu celular abrí WhatsApp y andá a:");
      log.info("  Configuración → Dispositivos vinculados →");
      log.info("  Vincular un dispositivo →");
      log.info("  'Vincular con número de teléfono' (abajo) →");
      log.info("  ingresá el código de arriba.");
      log.info("════════════════════════════════════════════════════");
      log.info("");
    } catch (e) {
      log.error("requestPairingCode falló:", e instanceof Error ? e.message : e);
    }
  }, 4_000);

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
