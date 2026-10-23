# Railway staging — configuración de referencia

**Estado:** **EJECUTADA el 2026-10-19**. Este documento conserva el diseño y las
variables; el estado real (URL, servicios, restore y pruebas) está en
`STAGING_RAILWAY.md`.
**Fecha de diseño:** 2026-10-19 · **Commit congelado:** `408a8f5` · **Tag:** `pre-railway-2026-10-19`

> Este documento describe cómo se creará el entorno **cuando se autorice la Fase E**.
> Nada de lo que figura acá se ejecutó. Producción (Vercel + Neon) permanece intacta.

---

## 1. Reglas del entorno

- Staging es un **proyecto/entorno separado** de Producción, con su propia base.
- **No** se reutilizan credenciales live de Mercado Pago.
- **No** se toca `umantai.com`, DNS ni el proyecto Vercel.
- **No** se ejecutan migraciones ni se copia el dump en esta etapa.
- El driver YA es portable: `lib/db-driver.server.ts` usa Neon por defecto y `pg`
  para cualquier otro host (Railway). `DB_DRIVER=pg` lo fuerza explícitamente.

---

## 2. Topología objetivo

```
Railway Project: UMANTAI
├── Environment: staging
│   ├── web          Next.js 16 · Node 22 · 1 réplica
│   ├── postgres     PostgreSQL 17 · volumen persistente
│   └── cron         servicio programado (cada 15 min)
└── Environment: production    ← NO se crea en esta fase
```

- Región: elegir la más cercana a Perú y a la región de Neon que se use como origen.
- Red: `web` y `postgres` en la **red privada** de Railway.
- Storage: no hace falta hoy (no hay uploads). Sólo volumen para Postgres.

---

## 3. Config-as-code

`railway.json` (raíz) fija:

| Campo | Valor | Motivo |
|---|---|---|
| `build.builder` | `NIXPACKS` | Build estándar de Next.js |
| `build.buildCommand` | `npm ci && npm run build` | Instala desde lockfile y compila |
| `deploy.startCommand` | `npm run start` | `next start` respeta `PORT` de Railway |
| `deploy.healthcheckPath` | `/api/health` | Chequeo barato y sin secretos (200/503) |
| `deploy.healthcheckTimeout` | `120` | Margen para el primer arranque |
| `deploy.restartPolicyType` | `ON_FAILURE` | Reinicio acotado |
| `deploy.restartPolicyMaxRetries` | `5` | Evita bucles infinitos |

No se agrega `.nvmrc` ni `engines` a `package.json`: eso también afectaría el build de
Vercel. La versión de Node se fija en Railway con `NIXPACKS_NODE_VERSION=22`.

---

## 4. Variables del servicio `web` (staging)

Los valores entre `<>` son placeholders. **Nunca** se commitean secretos.

| Variable | Valor staging | Obligatoria | Nota |
|---|---|---|---|
| `APP_ENV` | `staging` | Sí | Señal primaria de entorno |
| `NIXPACKS_NODE_VERSION` | `22` | Sí | Next 16 requiere Node ≥ 20.9 |
| `POSTGRES_URL_NON_POOLING` | `${{Postgres.DATABASE_URL}}` | Sí | Referencia interna de Railway |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Sí | Fallback y Payload |
| `DB_DRIVER` | `pg` | Recomendada | Neon HTTP no funciona contra Railway; el autodetect por host también daría `pg` |
| `PGPOOL_MAX` | `10` | No | Pool por proceso; bajar si hay muchas réplicas |
| `PAYLOAD_SECRET` | `<openssl rand -hex 32>` | **Sí, también en build** | Sin él, `next build` falla en Railway |
| `ADMIN_API_SECRET` | `<32+ chars aleatorios>` | Sí | Panel y APIs de admin |
| `KIOSK_ACCESS_CODE` | `<10+ chars aleatorios>` | Sí | Kiosco |
| `CRON_SECRET` | `<aleatorio>` | Sí | Autorización del cron |
| `COMMERCE_RESERVATION_TTL_MINUTES` | `30` | No | Default del código |
| `ONLINE_PAYMENTS_ENABLED` | **no definir** | No | Cobro online **congelado**: sin `1`, no se muestra el botón y la ruta de pago responde 503 sin llamar a Mercado Pago |
| `MERCADOPAGO_ACCESS_TOKEN` | `<token de la app de PRUEBA>` | Sin uso (congelado) | Nunca credenciales live |
| `MERCADOPAGO_WEBHOOK_SECRET` | `<secreto de la app de PRUEBA>` | Sin uso (congelado) | Sin él → 503 |
| `MERCADOPAGO_BACK_URL_BASE` | `https://staging.umantai.com` | Sin uso (congelado) | `back_urls` estables |
| `RESEND_API_KEY` | `<opcional>` | No | Sin ella, el pedido sigue funcionando |
| `RESEND_FROM_EMAIL` | `Umantai <onboarding@resend.dev>` | No | Sólo entrega al dueño de la cuenta |
| `NEXT_PUBLIC_SUPABASE_URL` | `<si se conserva notes/shopping list>` | No | Sin ellas, auth SSR queda inactiva |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `<...>` | No | Idem |
| `SUPABASE_SERVICE_ROLE_KEY` | `<...>` | No | Idem |
| `NEXT_PUBLIC_WHATSAPP_*` | `<opcional>` | No | UI |
| `MP_PAYMENT_SIMULATION` | `1` (sólo si se quiere simular pagos) | No | Gate migrado a `APP_ENV`; con `APP_ENV=staging` funciona |
| `QA_CLEANUP` | `1` (opcional) | No | Limpieza de pedidos QA; mismo gate que la simulación |
| `MP_ORDERS_*` | **no definir** | No | Experimento congelado |
| `VERCEL_ENV` | **no definir** | No | No existe en Railway; el código debe usar `APP_ENV` |

**Nunca** definir en staging: credenciales live de Mercado Pago, `VERCEL_ENV`, secretos
de Producción ni `MP_ORDERS_*`.

---

## 5. PostgreSQL

- Servicio gestionado **PostgreSQL 17** (misma major que el origen).
- Volumen persistente adjunto.
- `DATABASE_URL` de Railway apunta a la red privada (`postgres.railway.internal`),
  **sin SSL**. Si se usa el proxy público, agregar `?sslmode=require`.
- Verificar al crear: `server_version`, timezone (`UTC`), `max_connections` y extensiones
  (`plpgsql`).
- El esquema es estándar: no requiere extensiones adicionales.
- **No asumir PITR.** Programar `pg_dump` a R2/S3 y verificar restauración.

---

## 6. Cron

`vercel.json` no se lee en Railway. Los endpoints siguen existiendo y
protegidos por `CRON_SECRET`:

```
GET /api/cron/expire-reservations   → reservas vencidas de pedidos
GET /api/cron/billing               → planes: renovación, cancelación, gracia
Authorization: Bearer <CRON_SECRET>
```

**Un solo servicio cron** (sin crear otro recurso) ejecuta ambos jobs:

```bash
APP_BASE_URL=http://web.railway.internal:3000 \
CRON_SECRET=<secreto> \
node scripts/run-cron.mjs
```

- corre los dos jobs en orden, con timeout independiente;
- si uno falla se registra y el otro se ejecuta igual;
- exit 1 si cualquiera falla (incluye billing 200 con `ok:false`);
- no duplica lógica: cada job llama a su endpoint;
- billing sigue idempotente, así que cada 15 minutos es seguro.

En Railway: servicio `cron` existente con
`buildCommand=echo cron: no build required`, schedule `*/15 * * * *` y
start command `node scripts/run-cron.mjs`.
El cron de Vercel (`0 3 * * *`) NO se elimina hasta el cutover.

Disparos manuales: `scripts/trigger-expire-reservations.mjs` y
`scripts/trigger-billing.mjs` (mismo cliente compartido).

### Verificación real en staging (2026-10-20)

Servicio `cron` actualizado a `node scripts/run-cron.mjs`, schedule
`*/15 * * * *`, sin crear un segundo servicio.

- Corrida off-schedule (deployment `08bca6cb`, 6 s):
  `[cron] expire-reservations ok … {"ok":true,"expiredOrders":0}` y
  `[cron] billing ok … {"ok":true,"renewed":0,"failed":0}`; resumen
  `"ok": true` y exit 0.
- Ejecución con los secretos reales del servicio
  (`railway run -s cron … node scripts/run-cron.mjs`): ambos endpoints 200,
  reservas 751 ms y billing 499 ms, exit 0.
- El aislamiento de fallos y el exit 1 están cubiertos por
  `tests/cron-runner.test.ts` (job caído, fallo parcial `ok:false`, secreto
  ausente).

---

## 7. Orden de ejecución futuro (no ejecutado)

1. Crear proyecto/entorno `staging` en Railway (requiere login/token de Railway).
2. Crear el servicio PostgreSQL 17 y su volumen.
3. Cargar variables del servicio `web` (sin secretos live).
4. Tomar el backup de la base origen y verificar la restauración.
5. Copiar la base a staging y correr `audit-schema` en origen y destino.
6. Aplicar 004–007 **sobre la copia** y volver a comparar el fingerprint.
7. Desplegar `web` con el driver `pg` (ya implementado en esta rama).
8. Smoke tests, `/api/health` y integración contra la base staging.

Los pasos 1–8 se ejecutaron el 2026-10-19; evidencia y estado real en
`STAGING_RAILWAY.md`. El entorno `production` de Railway sigue vacío.

---

## 8. Pre-flight obligatorio antes de conectar la app

- [x] Driver `pg` implementado y probado contra PostgreSQL 17 real (integración).
- [x] `PAYLOAD_SECRET` presente en build y runtime.
- [x] `APP_ENV=staging` (no `VERCEL_ENV`).
- [x] Esquema reconciliado: 001–007 presentes y verificados con fingerprint.
- [x] Gates QA (simulación y cleanup) migrados de `VERCEL_ENV` a `APP_ENV`.
- [ ] Captura de soporte de webhook: sigue atada a `VERCEL_ENV=preview` (diagnóstico Vercel; en staging queda apagada).
- [x] Headers de `vercel.json` movidos a `next.config.ts`.
- [x] Entrypoint de cron portable con `CRON_SECRET`; servicio único creado y ejecución verificada (reservas + billing).
- [x] `/api/health` con chequeo de base y timeout de 2 s.
- [x] CI bloqueante: tsc, unitarios, integración y lint incremental.
- [x] Backup verificado (restore + fingerprint) y estado documentado en `STAGING_RAILWAY.md`.
- [ ] Runbook de rollback escrito.
- [ ] Correo con dominio verificado (o aceptar que no llega al comprador).
- [ ] Ninguna credencial live de Mercado Pago en staging.

---

## 9. Rollback

- Vercel + Neon **no se tocan** durante toda la migración.
- El dominio sigue apuntando a Vercel hasta el cutover (Fase H).
- Si staging falla, se destruye el entorno staging; Producción no se entera.
- En un cutover futuro: TTL de DNS bajo, ventana de congelamiento de escrituras y
  restauración desde el dump verificado.

---

## 10. Qué NO se hizo

- No se creó ningún proyecto, servicio ni base en Railway.
- No se copió ni se dumpeó ninguna base.
- No se desplegó la app.
- El driver `pg` está implementado y probado localmente, pero no conectado a Railway.
- No se aplicaron migraciones.
- No se tocó DNS, Vercel, Neon ni Mercado Pago.
- No se movió código.
