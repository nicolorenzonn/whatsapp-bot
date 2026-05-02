# WhatsApp Broadcaster — bot service

Proceso Node + Baileys que mantiene una sesión de WhatsApp Web abierta 24/7 y ejecuta las tareas programadas que vos creás desde el dashboard `/whatsapp` de control-financiero.

## Dos formas de correrlo

### 1) En la nube (recomendado: Railway)

24/7 real, sin depender de tu PC. Ver "Deploy en Railway" abajo.

### 2) Local en tu Mac

Más simple para arrancar pero el bot solo funciona mientras la PC esté prendida y conectada.

```bash
cd whatsapp-bot
npm install
cp .env.example .env
# Editar .env con SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WSP_BOT_USER_ID
npm run pair       # escaneás QR
npm start          # daemon corriendo
```

Para que sobreviva al cierre de terminal, `pm2 start npm --name wsp-bot -- start`.

---

## Deploy en Railway

### Setup (una sola vez)

1. **Crear cuenta** en [railway.app](https://railway.app) — login con GitHub.
2. **New Project** → **GitHub Repository** → autorizar Railway → elegir `control-financiero`.
3. **Settings → Source**:
   - **Root Directory**: `whatsapp-bot`
   - **Builder**: Dockerfile (Railway lo detecta solo)
4. **Settings → Networking**:
   - **Healthcheck Path**: `/healthz`
   - **Healthcheck Timeout**: 30s
5. **Settings → Volumes** → **New Volume**:
   - Mount path: `/app/auth`
   - Size: 1 GB es suficiente
6. **Variables** → pegá las de `.env.example` con tus valores reales:
   ```
   SUPABASE_URL=https://xxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...
   WSP_BOT_USER_ID=tu-uuid
   WSP_PAIRING_PHONE=549...        ← número internacional sin "+"
   ANTHROPIC_API_KEY=sk-ant-...    ← opcional
   ANTHROPIC_MODEL=claude-haiku-4-5
   WSP_AUTH_DIR=/app/auth          ← apuntar al volumen
   LOG_LEVEL=info
   ```

### Primer pareo

1. **Deploy** automático apenas guardás las variables.
2. Andá a **Deployments → ver logs** del último deploy.
3. Buscá una línea tipo:
   ```
   ════════════════════════════════════════════════════
     PAIRING CODE: ABCD-1234
     En tu celular abrí WhatsApp y andá a:
     ...
   ════════════════════════════════════════════════════
   ```
4. En tu **celular**: WhatsApp → Configuración → Dispositivos vinculados → Vincular un dispositivo → **"Vincular con número de teléfono"** (link abajo) → ingresá el código.
5. Logs van a mostrar `✓ Pareado correctamente con +549...` y `Daemon listo`.
6. ¡Listo! El bot queda corriendo 24/7 en la nube.

### Re-pareo (si la sesión se invalida)

WhatsApp puede invalidar la sesión si pasa mucho tiempo offline o si la cerrás manualmente desde el celular ("Dispositivos vinculados" → cerrar sesión).

Para volver a parear:
1. Railway → tu service → **Volumes** → click el volumen → **Wipe** (vacía el volumen).
2. **Deployments → Redeploy**. Logs te muestran un pairing code nuevo.

---

## Variables de entorno

Ver `.env.example` para la lista completa con comentarios.

| Variable | Requerida | Descripción |
|---|---|---|
| `SUPABASE_URL` | sí | URL del proyecto Supabase (mismo que la SPA) |
| `SUPABASE_SERVICE_ROLE_KEY` | sí | Service role key — bypassa RLS, no exponer |
| `WSP_BOT_USER_ID` | sí | UUID del user (de auth.users) |
| `WSP_PAIRING_PHONE` | en cloud | Número internacional sin "+" (ej 5491134567890) |
| `ANTHROPIC_API_KEY` | no | Para reescribir mensajes con Claude (opción `variar_con_ia`) |
| `WSP_AUTH_DIR` | no | Path donde Baileys persiste la sesión (default `./auth`) |
| `PORT` | no | Healthz HTTP server port (Railway lo inyecta) |
| `LOG_LEVEL` | no | `debug` `info` `warn` `error` |

## Comandos

```bash
npm run pair        # primer pareo (QR local o pairing code en cloud)
npm start           # daemon
npm run typecheck
```

## Endpoints

- `GET /healthz` → 200 si Baileys está conectado, 503 si no
- `GET /` → idéntico a `/healthz`

## Troubleshooting

- **Logs spamean "got history notification"** → Baileys sincronizando historial inicial. Normal en los primeros minutos.
- **Tareas no se mandan** → revisá que `next_run` esté seteado en `wsp_tasks`. Si es null, el bot las ignora. Crear/editar la tarea desde la UI fuerza recálculo.
- **Pairing code expira sin entrarlo** → tiene ~3-5 min de vida. Redeployá para generar uno nuevo.
- **Baileys "stream errored 515" después del pareo** → es esperable, Baileys reinicia el socket post-pair y reconecta solo.
