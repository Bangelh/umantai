# Umantai - Environment Variables

> **Recommended**: Use the helper at `lib/env.ts` for type-safe access to these variables throughout the app.

## Using the Helper

Instead of accessing `process.env` directly, import from the helper:

```ts
import { envConfig } from '@/lib/env';

// Example usage
console.log(envConfig.supabase.url);
console.log(envConfig.whatsapp.salesPhone);
console.log(envConfig.vercel.isProduction);
```

This gives you:
- Full TypeScript support
- Automatic fallback handling for Vercel integration prefixes (BANGELH_ from Bangelh, UMANTAI_URL_ from umantai vercel deploys e.g. umantai-dh4a-7zlzja1br-umantai.vercel.app, plus NEXT_PUBLIC_ insertion variants)
- Clear validation errors when variables are missing in production

This document lists all recommended environment variables for deploying Umantai on Vercel.

## Important Notes

- **Prefix support**: The code supports multiple Vercel/Supabase integration prefixes:
  - `BANGELH_*` / `BANGELH_NEXT_PUBLIC_*` — from Bangelh-linked Supabase integration
  - `UMANTAI_URL_*` / `NEXT_PUBLIC_UMANTAI_URL_*` — injected by umantai Vercel project (e.g. preview URLs like umantai-dh4a-7zlzja1br-umantai.vercel.app)
  - Plus direct (unprefixed) names always work as fallback.
- Postgres variables (POSTGRES_URL*, DATABASE_URL etc.) are usually auto-injected when you connect a Postgres database via Vercel Marketplace / Neon or other (prefixed variants also resolved).
- `SUPABASE_SERVICE_ROLE_KEY` is required for server-side operations (especially the Notes feature due to Row Level Security).

---

## Production

### Supabase (solo datos legacy: notas y listas — NO es autenticación)
```env
# Main Supabase project URL (with custom prefix - any supported)
BANGELH_NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
# or UMANTAI_URL_NEXT_PUBLIC_SUPABASE_URL=... (or NEXT_PUBLIC_UMANTAI_URL_SUPABASE_URL=...)

# Public anon key (safe for client-side)
BANGELH_NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key

# Secret Service Role Key (server-only, bypasses RLS)
BANGELH_SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Fallbacks (standard names without prefix) — always supported
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

### WhatsApp
```env
# WhatsApp de ventas/atención (OPCIONAL). Sin esta variable se usa el número
# confirmado en `config/business.ts` (+51 979 363 149), que ya incluye el código
# de país al armar el enlace wa.me. No duplicar el número en páginas.
NEXT_PUBLIC_WHATSAPP_SALES_PHONE=51979363149

# Ventas y atención comparten el mismo canal: el botón flotante muestra uno solo.
NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE=51979363149

# Mensajes por defecto al abrir WhatsApp (opcionales).
NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE=Hola, quisiera saber más sobre los productos de Umantai.
NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE=Hola, necesito ayuda con mi pedido o mi cuenta.
```

### Postgres
```env
# Main connection string (often pooled)
POSTGRES_URL=postgres://...

# Recommended for Prisma ORM
POSTGRES_PRISMA_URL=postgres://...

# Direct (non-pooled) connection - strongly recommended for local dev
POSTGRES_URL_NON_POOLING=postgres://...

POSTGRES_USER=...
POSTGRES_PASSWORD=...
POSTGRES_HOST=...
POSTGRES_DATABASE=...
```

### Driver de base de datos (portable)
```env
# Fuerza el driver. Valores: neon | pg. Si falta, se autodetecta por host:
# *.neon.tech → neon; cualquier otro host (Railway, Supabase, local) → pg.
# Neon sigue siendo el comportamiento por defecto en la base actual.
DB_DRIVER=pg

# Tamaño máximo del pool de `pg` por proceso (default 10, rango 1–50).
# Sólo aplica al driver pg; el driver HTTP de Neon no usa pool TCP.
PGPOOL_MAX=10
```

### Mercado Pago (Checkout Pro)
```env
# Private key of your Mercado Pago application. REQUIRED to create payment links.
# Test credentials while developing, live credentials (APP_USR-) in production.
# Never expose this one to the browser (no NEXT_PUBLIC_ prefix).
MERCADOPAGO_ACCESS_TOKEN=APP_USR-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Secret key Mercado Pago uses to sign its webhook notifications (HMAC-SHA256).
# REQUIRED to accept payments: without it /api/payments/webhook cannot tell a real
# payment from anyone who found the URL. Copy it from Your integrations → Webhooks
# (the signature secret, not the access token).
MERCADOPAGO_WEBHOOK_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Force the sandbox checkout URL (`sandbox_init_point`) instead of `init_point`.
# Usually not needed: with test credentials Mercado Pago already routes to the sandbox.
MERCADOPAGO_SANDBOX=false

# Optional: override the base for back_urls / notification_url (defaults to the
# request host, honouring x-forwarded-host behind Cloudflare/Vercel).
MERCADOPAGO_BACK_URL_BASE=https://umantai.com

# Optional: statement descriptor shown on the buyer's card statement.
# Not supported in every country — only sent when set.
MERCADOPAGO_STATEMENT_DESCRIPTOR=UMANTAI
```

> The webhook at `/api/payments/webhook` must be reachable from the internet, so
> `MERCADOPAGO_BACK_URL_BASE` is what you use while testing locally: point it at a
> tunnel (`cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`).
> Mercado Pago needs both the notification URL and the signature secret configured
> in Your integrations → Webhooks.

### Interruptor del pago online (congelado)
```env
# Mercado Pago está congelado por decisión del negocio. Mientras no exista
# ONLINE_PAYMENTS_ENABLED=1, la página del pedido NO muestra el botón de pago y
# POST /api/payments/preference responde 503 (online_payments_unavailable) ANTES de
# llamar a Mercado Pago. No hace falta quitar credenciales: el interruptor manda.
# Default seguro: ausente = congelado. Reabrir el cobro es cambiar esta variable,
# no tocar código.
ONLINE_PAYMENTS_ENABLED=0
```

> El resto del flujo no cambia: el pedido se crea en `pending_payment`, la reserva
> de stock vence igual y el retiro en locker sigue funcionando. No usar este flag
> para el experimento `mp-orders` (ese tiene sus propios candados).

### Mercado Pago Orders API (experimento QA — NO productivo)

Estas variables son SOLO para el experimento aislado `mp-orders` (Checkout Pro vía
Orders API). No las usan la tienda ni el flujo legacy de Preferences: son un juego
separado de credenciales, con su propio access token y su propio webhook secret.

```env
# Access token de la aplicación de Mercado Pago del experimento Orders (backend only).
# Si falta, POST /api/mp-orders/create responde 503 (fail-closed, nunca cae al legacy).
MP_ORDERS_ACCESS_TOKEN=APP_USR-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Secreto de firma del webhook de la aplicación Orders (el que genera Mercado Pago al
# guardar la config de Webhooks con el evento "Order (Mercado Pago)"). Sin él, el
# receptor responde 503: no hay forma de distinguir un aviso real de una invención.
MP_ORDERS_WEBHOOK_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Base absoluta (con https) de las URLs de retorno de la order: se derivan
# <base>/?mp_orders=success|failure|pending y se añade auto_return=approved.
# Si falta, la order se crea SIN config: es opcional y no se inventan URLs.
MP_ORDERS_BACK_URL_BASE=https://<tu-preview>.vercel.app

# Email de la CUENTA DE PRUEBA COMPRADOR de la aplicación (la que Mercado Pago crea
# junto a la app; se ve en Tus integraciones → Cuentas de prueba → Comprador).
# NO es un email inventado que "parezca" de sandbox: si no es el de esa cuenta, la
# order se crea (201) pero el checkout hospedado no puede resolver al comprador y
# muestra un error genérico. Si falta, la creación falla cerrado con 503
# (mp_orders_qa_payer_email_missing). Nunca se loguea ni se devuelve en una respuesta.
MP_ORDERS_QA_PAYER_EMAIL=test_user_xxxxxxx@testuser.com
```

> **Candados de la ruta de creación** (`POST /api/mp-orders/create`): entorno NO
> productivo + `x-admin-token` válido + `MP_ORDERS_ACCESS_TOKEN` + el comprador QA.
> El `payer.email` NO se acepta desde el body (responde 400): el comprador lo define
> el servidor. En Producción la ruta responde 404.

> 🔒 **EXPERIMENTO CONGELADO (2026-10-15):** la creación y la lectura de la Order
> (201 / 200, `status: created`, `errors: null`, back_urls correctas) funcionan, pero
> el **checkout hospedado de Mercado Pago falla antes del login del comprador** y
> redirige a `/checkout/v1/payment/redirect/exception` (código `COW00-W6GQPYJPOVPZ`).
> Hay ticket abierto con soporte. No se crean más Orders ni se cambian payloads,
> credenciales, webhooks, Preferences ni Producción. Detalle completo en
> `MP_ORDERS_STATUS.md` (incluye la ruta read-only `GET /api/admin/qa/mp-orders/[orderId]`).

### Entorno de ejecución (opcional pero recomendado)

```env
# Señal EXPLÍCITA del entorno, independiente del hosting. Es la primera que se mira
# (ver `lib/runtime-environment.server.ts`). Valores: production | staging | preview |
# development. Si no está, se usa VERCEL_ENV y, fuera de Vercel, NODE_ENV.
# FAIL-CLOSED: un valor no reconocido se trata como Producción.
# Sirve para que los gates "solo fuera de Producción" sigan funcionando al migrar el
# runtime (p. ej. Railway), donde VERCEL_ENV no existe.
APP_ENV=preview
```

### Kiosco (panel de la operaria)
```env
# Shared secret that unlocks /admin/kiosco. Verified SERVER-SIDE (never in the bundle):
# the kiosk validates pickup PINs and commits inventory, so this endpoint cannot be
# public. It is a device lock, not user authentication — rotate it when staff change.
# If it is missing, the kiosk stays CLOSED (routes answer 503). Minimum 10 characters.
KIOSK_ACCESS_CODE=change-me-long-random-string
```

> The device key is typed once on the tablet and kept in memory only. It is a device
> lock, not a person: staff identity uses Better Auth (ver `AUTH_DECISION.md`).

### Panel de administración (token de API)
```env
# Secreto compartido que protege el panel /admin y TODAS las APIs de administración
# (/api/admin/*, /api/products, /api/categories, /api/brands, /api/notes, /api/debug/env).
# Se verifica SERVIDOR-side contra el header `x-admin-token`; nunca viaja en el bundle.
# Si falta, esas rutas responden 503 (fallan cerrado, igual que el kiosco).
# Mínimo 16 caracteres; usa 32+ aleatorios (p. ej. `openssl rand -hex 32`). Rótalo cuando
# salga del equipo.
ADMIN_API_SECRET=change-me-long-random-string
```

> El panel ya NO usa una contraseña hardcodeada (`umantai`): eso era security theater,
> porque viajaba en el bundle que descarga cualquier visitante. Ahora el panel pide este
> token, lo guarda en el navegador y lo manda en el header `x-admin-token`.
>
> **Fase Multi-Tienda:** el panel de comerciante (`/negocio`) YA NO usa este token: usa
> sesión real + `store_members`. El token queda como puente de ADMINISTRACIÓN DE
> PLATAFORMA (aprobar tiendas, tools de QA) hasta que exista un rol global en `users`.
> No es un tercer sistema de usuarios: es la misma tabla `users`, sin rol de plataforma
> todavía (ver `AUTH_DECISION.md` §7).
> El kiosco usa SU PROPIA clave (`KIOSK_ACCESS_CODE`), separada a propósito: quien edita
> precios no debería poder, con esa misma credencial, entregar mercadería.

### Storage de imágenes (multi-tienda)

```env
# db = fallback de staging (bytea en media_assets, servido por /api/media/<key>).
# r2 = bucket S3-compatible de Cloudflare. Default: db.
MEDIA_DRIVER=db

# Solo si MEDIA_DRIVER=r2. Usa credenciales/bucket DE STAGING, nunca Producción.
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=umantai-staging-media
# Opcional: dominio público del bucket. Sin él, la app sirve por /api/media/<key>.
R2_PUBLIC_BASE_URL=
```

> El adaptador está en `lib/storage.server.ts`. Valida MIME real (JPEG/PNG/WebP),
> tamaño máximo 2 MB y genera la key del servidor. Staging puede operar con
> `MEDIA_DRIVER=db` sin bloquear la fase; la única configuración pendiente para
> storage real es completar las cinco variables R2 en el entorno de staging.
> No reutilices las credenciales de Producción.

### Autenticación de usuarios (Better Auth)
```env
# Secreto de firma de sesiones. OBLIGATORIO en Producción: 32+ caracteres aleatorios
# (`openssl rand -hex 32`). En staging/desarrollo, si falta, se usa un secreto efímero y
# se avisa en logs; NUNCA se usa el fallback en Producción.
BETTER_AUTH_SECRET=change-me-long-random-string

# URL pública con la que se validan cookies y orígenes (Better Auth trustedOrigins).
# En staging: https://web-staging-6756.up.railway.app
# En Producción: https://umantai.com
# Si falta, se usa NEXT_PUBLIC_SERVER_URL / NEXT_PUBLIC_SITE_URL.
BETTER_AUTH_URL=https://umantai.com
```

> Sesiones en PostgreSQL (tablas `sessions`, `auth_accounts`) con cookie HttpOnly.
> El registro/login es email + contraseña (mínimo 8 caracteres). OAuth se agrega con un
> plugin de Better Auth sin cambiar el modelo: la identidad sigue siendo `users.id`.
> `store_members.user_id` referencia esa misma identidad.

### Notificaciones al cliente (Resend)
```env
# API key de Resend (https://resend.com/api-keys). Sin ella no se envía ningún aviso:
# el kiosco lo reporta en pantalla, no falla.
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx

# Remitente. Por defecto `Umantai <onboarding@resend.dev>`, la dirección de PRUEBAS de
# Resend: sólo entrega al correo dueño de la cuenta. Como el aviso va al COMPRADOR, hay
# que verificar el dominio en Resend y poner acá ese remitente antes de vender el servicio.
RESEND_FROM_EMAIL=Umantai <pedidos@umantai.com>
```

> El destinatario ya no se configura por entorno: sale del pedido (`orders.contact_email`,
> el correo que el comprador dejó en el checkout). El aviso lleva el PIN de retiro y se
> dispara cuando la operaria marca "YA ESTÁ EN EL CASILLERO". Es *best-effort*: si el
> correo falla —o el pedido no trae un correo válido—, el pedido igual queda listo y la
> pantalla del kiosco muestra la advertencia para que la operaria lo resuelva en el
> mostrador. No hay reintento automático.
> `ADMIN_NOTIFICATION_EMAIL` quedó obsoleto y ya no se lee.

### Sitio público, contacto y sellado del build (Fase 2)
```env
# URL absoluta del sitio: canonical, Open Graph, robots.txt y sitemap.xml.
# Orden de resolución: NEXT_PUBLIC_SITE_URL > NEXT_PUBLIC_SERVER_URL >
# https://umantai.com (solo en producción).
NEXT_PUBLIC_SITE_URL=https://umantai.com

# Destinatario del aviso del formulario de contacto. OPCIONAL: sin esta variable se usa el
# correo de atención confirmado en `config/business.ts`. Sin RESEND_API_KEY el mensaje se
# guarda igual en `contact_messages`; solo no sale el correo y la UI lo informa.
CONTACT_TO_EMAIL=juancallerosales19@gmail.com

# Correo legal mostrado en privacidad/términos/reembolsos y en el aviso legal. OPCIONAL:
# sin esta variable se usa el correo confirmado en `config/business.ts`.
LEGAL_EMAIL=juancallerosales19@gmail.com
```

```env
# Sellado del build (/api/health). NO son secretos.
# `scripts/write-build-info.mjs` (prebuild) resuelve el commit en este orden:
#   BUILD_COMMIT > VERCEL_GIT_COMMIT_SHA > RAILWAY_GIT_COMMIT_SHA >
#   GIT_COMMIT_SHA > GIT_COMMIT > `git rev-parse HEAD`
# Con `railway up` conviene fijar GIT_COMMIT_SHA antes del deploy (como ya se hace en
# staging) o BUILD_COMMIT. Si el build real no resuelve commit, health devuelve
# commit=null (nunca hereda el SHA viejo de la plataforma) y el build queda identificado
# por build.buildId.
BUILD_COMMIT=
BUILD_ID=
```

> `/api/health` ahora devuelve `commit` + `build { buildId, commitSource, builtAt }`.
> `commit` describe el código desplegado; `buildId` cambia en cada build aunque el commit
> no cambie. Es el reemplazo de confiar en `RAILWAY_GIT_COMMIT_SHA`, que queda obsoleto
> con `railway up`.

### Additional / Recommended
```env
# Current environment (production, preview, development)
# Very useful for conditional logic
VERCEL_ENV=production

# Public URL of the current deployment (useful for absolute URLs, webhooks, etc.)
VERCEL_URL=your-project.vercel.app
```

---

## Preview

### Supabase (solo datos legacy: notas y listas — NO es autenticación)
```env
BANGELH_NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
BANGELH_NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
BANGELH_SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

### WhatsApp
```env
NEXT_PUBLIC_WHATSAPP_SALES_PHONE=51979363149
NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE=51979363149
NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE=Hello! I'd like to know more about your products.
NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE=Hello! I need help with my order or account.
```

### Postgres
```env
POSTGRES_URL=postgres://...
POSTGRES_PRISMA_URL=postgres://...
POSTGRES_URL_NON_POOLING=postgres://...
POSTGRES_USER=...
POSTGRES_PASSWORD=...
POSTGRES_HOST=...
POSTGRES_DATABASE=...
```

### Additional
```env
VERCEL_ENV=preview
VERCEL_URL=your-project-git-branch.vercel.app
```

---

## Development

### Supabase (solo datos legacy: notas y listas — NO es autenticación)
```env
BANGELH_NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
BANGELH_NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
BANGELH_SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

### WhatsApp
```env
NEXT_PUBLIC_WHATSAPP_SALES_PHONE=51979363149
NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE=51979363149
NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE=Hello! I'd like to know more about your products.
NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE=Hello! I need help with my order or account.
```

### Postgres
```env
POSTGRES_URL=postgres://...
POSTGRES_PRISMA_URL=postgres://...
POSTGRES_URL_NON_POOLING=postgres://...
POSTGRES_USER=...
POSTGRES_PASSWORD=...
POSTGRES_HOST=...
POSTGRES_DATABASE=...
```

### Mercado Pago (Checkout Pro)
```env
# Test credentials from Your integrations > Integration data > Test credentials
MERCADOPAGO_ACCESS_TOKEN=TEST-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Same account-level signature secret. Required to receive notifications at all.
MERCADOPAGO_WEBHOOK_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional, see the Production section for the full list.
# Point it at your tunnel so back_urls and notification_url are publicly reachable.
MERCADOPAGO_BACK_URL_BASE=https://your-tunnel.trycloudflare.com
```

### Kiosco (panel de la operaria)
```env
# Same device key as in production. Without it /api/kiosk/* answers 503.
KIOSK_ACCESS_CODE=dev-kiosk-code-at-least-10-chars
```

### Notificaciones al cliente (Resend)
```env
# Opcional en desarrollo. Con `onboarding@resend.dev` (el remitente por defecto) Resend
# sólo entrega al correo dueño de la cuenta, así que para probar usa ESA dirección como
# `contact_email` del pedido de prueba.
# Si falta la API key, el kiosco funciona igual y avisa que no se pudo notificar.
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx
```

> Quick local check: open `http://localhost:3000/admin/kiosco`, type the key, then
> redeem a real PIN from a `ready_for_pickup` order in your Neon dev branch. You can
> move an order there from the kiosk's own PREPARAR tab.

### Additional
```env
VERCEL_ENV=development
```

---

## Healthcheck y cron (portables)

### `GET /api/health`

Healthcheck para Railway (y cualquier hosting). Devuelve sólo:

```json
{
  "ok": true,
  "version": "0.1.0",
  "commit": "<sha o null>",
  "environment": "staging",
  "database": { "reachable": true, "type": "pg" },
  "timestamp": "2026-10-19T12:00:00.000Z"
}
```

- `200` si la base responde, `503` si no (o si no hay connection string).
- `COMMIT` se toma de `VERCEL_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA`,
  `GIT_COMMIT_SHA` o `GIT_COMMIT` (el primero presente).
- **Nunca** incluye URL, host, usuario, password ni tokens. Puede quedar público.

### Cron portable (Railway)

`vercel.json` sólo lo lee Vercel. Para Railway hay un entrypoint que llama al
MISMO endpoint protegido por `CRON_SECRET`:

```bash
APP_BASE_URL=http://web.railway.internal:3000 \
CRON_SECRET=... \
node scripts/trigger-expire-reservations.mjs
```

En Railway: servicio cron con schedule `*/15 * * * *` y ese comando. El cron de
Vercel queda intacto hasta el cutover.

### Billing de planes (SaaS, separado de pedidos)

```bash
BILLING_PROVIDER=manual      # manual|test; cualquier otro valor falla cerrado
BILLING_GRACE_DAYS=3         # días de gracia de past_due
APP_BASE_URL=http://web.railway.internal:3000 \
CRON_SECRET=... \
node scripts/trigger-billing.mjs
```

`/api/cron/billing` es un job **distinto** del de reservas, pero comparte el
mismo servicio cron (`scripts/run-cron.mjs`, cada 15 min). El runner aísla
fallos y sale con exit ≠ 0 si cualquiera falla. El provider real no está
implementado todavía; ver `BILLING_PROVIDER.md`.

---

## CI (qué bloquea y qué no)

Bloqueantes en cada push/PR a `main` y `feat/railway-staging`:

- `npx tsc --noEmit` (sin `|| true`).
- `npm test` — 398 tests unitarios.
- `npm run test:integration` — PostgreSQL 17 efímero con `embedded-postgres`
  (job separado; no usa secretos ni toca Producción).
- **Lint incremental**: `eslint` estricto sólo sobre archivos JS/TS modificados
  desde `e4d39ad` (inicio de la migración). La deuda de lint histórica (113
  archivos de la etapa comercial) queda documentada y se salda aparte; al
  terminarla, subir `LINT_BASE_REF` en `.github/workflows/ci-cd.yml`.

---

## Summary of Recommended Additions

| Variable                        | Why It's Useful                                      | Recommended For |
|--------------------------------|------------------------------------------------------|-----------------|
| `APP_ENV`                      | Señal primaria de entorno, independiente del hosting | All             |
| `DB_DRIVER`                    | Fuerza `neon` o `pg`; si falta, se autodetecta       | All             |
| `BILLING_PROVIDER`             | `manual`/`test` para staging; real falla cerrado     | Staging         |
| `BILLING_GRACE_DAYS`           | Días de gracia antes de expirar `past_due`           | Staging/Prod    |
| `PLATFORM_ADMIN_SECRET`        | Firma la cookie de Platform Admin (≥32 chars). Si falta, usa `BETTER_AUTH_SECRET` | Staging/Prod |
| `PLATFORM_ADMIN_EMAILS`        | Bootstrap de admins por correo (lista separada por comas); la tabla `platform_admins` es la fuente principal | Staging |
| `PERU_HOLIDAYS`                | Feriados oficiales adicionales (`YYYY-MM-DD`, separados por coma) para el plazo del Libro de Reclamaciones | Staging/Prod (opcional) |
| `ALLOW_ADMIN_TOKEN_FALLBACK`   | `1` reactiva el token compartido en Producción (emergencia) | Prod (temporal) |
| `PLAYWRIGHT_BASE_URL`          | Base para `npm run e2e` (default: staging)           | CI/Dev          |
| `SMOKE_BASE_URL`               | Base para `scripts/security-smoke.mjs`               | CI/Staging      |
| `VERCEL_ENV`                   | Fallback de entorno en Vercel                        | Vercel          |
| `VERCEL_URL`                   | Get the public URL of the current deployment         | All             |
| `POSTGRES_URL_NON_POOLING`     | More reliable direct connection for local dev        | Development     |
| `BANGELH_*` / `UMANTAI_URL_*` prefixed keys | Match Supabase integration prefix (Bangelh or umantai vercel pulls) | All             |

---

### `PERU_HOLIDAYS` (opcional)

Agrega feriados nacionales oficiales declarados **después** del release, sin
tocar código. No reemplaza el calendario versionado de `lib/peru-holidays.ts` ni
marca un año como completo.

```env
PERU_HOLIDAYS=2026-07-24,2026-12-31
```

- Formato `YYYY-MM-DD`; se aceptan comas, espacios o saltos de línea.
- Las fechas inválidas se ignoran y el servidor registra solo la cantidad.
- Sirve para decretos puntuales. Para un año nuevo hay que cargar el calendario
  completo y subir la versión (ver `LIBRO_RECLAMACIONES.md`).

Verificación local: `npm test` (unitarios) y `npm run test:integration`
(PostgreSQL efímero, sin tocar ninguna base externa).