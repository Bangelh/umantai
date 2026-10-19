# UMANTAI — SEMANA 1 / FASE 0

**Fecha del informe:** 2026-10-19
**Rama auditada:** `feat/payment-simulation-qa`
**Commit congelado:** `408a8f50153c6a8ae1f833f716d5eaa4e3eb68bd`
**Tag de congelamiento:** `pre-railway-2026-10-19`
**Modo:** auditoría de solo lectura. No se migró producción, no se copió la base, no se tocó Mercado Pago, no se cambió el driver, no se aplicaron migraciones y no se movió código.

> **Alcance de la evidencia:** la base inspeccionada es la configurada en `.env.local` (Neon `neondb`, PostgreSQL 17.11). Por sus datos (14 pedidos de QA entre 2026-09-21 y 2026-09-27) es muy probablemente la rama de Preview/QA, **no Producción**. La base de Producción de Vercel no se verificó: no se dispone de sus credenciales. Las diferencias entre ambas son un riesgo abierto y están marcadas como tales.

---

## A. Estado base congelado

### Git

| Dato | Valor |
|---|---|
| Rama actual | `feat/payment-simulation-qa` |
| HEAD | `408a8f50153c6a8ae1f833f716d5eaa4e3eb68bd` — 2026-10-15 16:00 -0500 |
| Mensaje | `docs(mp-orders): congelar el experimento y documentar el bloqueo del checkout hospedado` |
| `main` | `4496551` — 2026-06-04 — **54 commits atrás de HEAD** |
| `feat/ecommerce-core` | `b9993cd` — 38 commits adelante de `main` |
| `feat/mercadopago-orders-cleanroom` | `e782979` — 41 commits adelante de `main` |
| Remoto | `https://github.com/Bangelh/umantai.git` |
| Rama remota extra | `origin/v0/neon-postgres-schema-2c48f247` |
| Estado | Limpio, salvo 2 bloques untracked preexistentes |

**Untracked preexistentes (no tocados):**

- `db/migrations/commerce-preview-initial.sql` (1602 líneas, concatenación de 001–003)
- `migrations/` → `20261001_171717_initial.json|.sql|.ts` + `index.ts` (baseline de Payload, **no aplicado**)

**Hallazgo:** todo el producto vive en la rama de feature. `main` está 4 meses atrás. No se puede determinar desde el repo qué rama construye Vercel Producción; hay que confirmarlo en Vercel → Settings → Git. El workflow `.github/workflows/ci-cd.yml` solo corre en `main` y en PRs a `main`: **el código actual no está cubierto por CI**, y ese CI oculta fallos con `|| true` en `tsc` y `eslint`.

### Versiones verificadas

| Componente | Versión real |
|---|---|
| Next.js | **16.2.6** |
| React / React DOM | **19.2.4** |
| TypeScript | **5.9.3** (declarado `^5`) |
| Payload | **3.85.0** |
| `@payloadcms/db-postgres` | 3.85.0 |
| `@neondatabase/serverless` | 1.1.0 |
| `pg` | 8.20.0 (transitiva, solo Payload) |
| Node local | 22.22.2 |
| Node en CI | 20 |
| PostgreSQL | **17.11** (Neon) |
| Base | `neondb`, owner `neondb_owner` |

### Infraestructura actual

| Área | Estado |
|---|---|
| Deploy | **Vercel** (`vercel.json`: región `iad1`, cron diario 03:00, `maxDuration: 30`) |
| Cloudflare | Configuración OpenNext + `wrangler.toml` + job de CI **presente pero no es el target activo** |
| DB | **Neon** (driver HTTP `@neondatabase/serverless`) |
| Auth de usuarios | **No operativa**: no hay pantalla de login. Supabase Auth está cableado (middleware + 2 rutas) pero sin UI y sin variables locales. El acceso real hoy es por **secretos compartidos** (`ADMIN_API_SECRET`, `KIOSK_ACCESS_CODE`) |
| Supabase | Sigue presente para Auth SSR, `notes` y `shopping_list_items`. Es **otra base**, fuera de las migraciones del repo |
| Neon Auth | Existe el schema `neon_auth` (9 tablas, vacías salvo `project_config`) y **ningún código lo usa** |
| Correo | **Resend**. Remitente por defecto `onboarding@resend.dev`, que solo entrega al dueño de la cuenta: **no sirve para avisar a compradores reales** |
| Mercado Pago | Flujo legacy de **Preferences + webhook** activo. **Orders API congelada** |
| Storage/uploads | **Ninguno**. No hay colección de uploads ni volumen; las imágenes son rutas/URLs |
| Payload | Configurado, pero **sin UI de admin montada** (solo `/api/payload/*`) y **sin tablas en la base inspeccionada** → hoy es peso muerto |

### Variables de entorno

Solo nombres y presencia. No se imprimió ningún valor.

| Variable | `.env.local` | Dónde se usa |
|---|---|---|
| `POSTGRES_URL_NON_POOLING` | ✅ | `lib/db.ts`, `lib/commerce.server.ts`, `payload.config.ts`, `setup-db`, `env.ts`, seed |
| `POSTGRES_URL` / `DATABASE_URL` | ❌ | fallbacks de las mismas rutas |
| `POSTGRES_PRISMA_URL` | ❌ | solo diagnóstico |
| `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` | ❌ | middleware, shopping list |
| `SUPABASE_SERVICE_ROLE_KEY` | ❌ | `notes`, shopping list |
| `PAYLOAD_SECRET` | ❌ | `payload.config.ts` (obligatorio en build de producción) |
| `ADMIN_API_SECRET` | ✅ | `/api/admin/*`, products, categories, brands, notes, debug |
| `KIOSK_ACCESS_CODE` | ✅ | `/api/kiosk/*` |
| `MERCADOPAGO_ACCESS_TOKEN` | ✅ | Preference + webhook |
| `MERCADOPAGO_WEBHOOK_SECRET` | ❌ | firma del webhook legacy (sin él → 503) |
| `MERCADOPAGO_BACK_URL_BASE` | ✅ | `back_urls` / `notification_url` |
| `MERCADOPAGO_SANDBOX` | ❌ | opcional |
| `MERCADOPAGO_STATEMENT_DESCRIPTOR` | ❌ | opcional |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | ✅ | notificaciones |
| `ADMIN_NOTIFICATION_EMAIL` | ✅ | **obsoleta**, el código ya no la lee |
| `CRON_SECRET` | ❌ | autorización del cron |
| `APP_ENV` | ❌ | `runtime-environment.server.ts` |
| `MP_ORDERS_ACCESS_TOKEN` / `WEBHOOK_SECRET` / `BACK_URL_BASE` / `QA_PAYER_EMAIL` | ❌ | módulo Orders congelado |
| `MP_PAYMENT_SIMULATION` | ❌ | simulación QA (solo Preview de Vercel) |
| `MP_WEBHOOK_SUPPORT_CAPTURE` | ❌ | captura de soporte (solo Preview) |
| `COMMERCE_RESERVATION_TTL_MINUTES` | ❌ | default 30 min |
| `NEXT_PUBLIC_WHATSAPP_*` | ❌ | UI |
| `NEXT_PUBLIC_SERVER_URL` | ❌ | declarada en `next.config.ts` y **nunca consumida** |
| `VERCEL_*` | inyectadas por Vercel | ver sección D |

### Verificación ejecutada (baseline real)

| Check | Resultado |
|---|---|
| `npm test` | ✅ **250/250** en 2.9 s |
| `npx tsc --noEmit` | ❌ **2 errores**, ambos en `migrations/20261001_171717_initial.ts` (untracked) por doble copia de `drizzle-orm`. El código tracked compila |
| `npm run lint` | ❌ **98 errores / 24 warnings** (baseline preexistente) |

**Matiz crítico:** los 250 tests son **unitarios/puros**. No hay tests de integración contra PostgreSQL (`tests/helpers/preview-env.ts` usa una URL ficticia y aclara que nunca abre conexión). Por eso 250/250 en verde **no demuestra** que el esquema aplicado sea el que el código espera.

---

## B. Arquitectura actual

### Mapa real

```
umantai/
├── app/
│   ├── page.tsx, layout.tsx            storefront (home)
│   ├── products/                       catálogo + detalle
│   ├── cart/                           carrito (Zustand)
│   ├── pedido/[token]/                 pedido público + PIN + pago
│   ├── list/                           lista de compras (sin auth real)
│   ├── kiosk/                          pantalla pública del kiosco
│   ├── admin/                          panel (page 1099 líneas)
│   │   ├── inventario/, kiosco/, notes/
│   ├── debug/                          env, supabase
│   └── api/                            34 route handlers
│       ├── orders/                     crear pedido
│       ├── payments/                   preference + webhook (522)
│       ├── mp-orders/                  experimento congelado
│       ├── kiosk/                      queue, ready, pickup
│       ├── admin/                      inventory, orders, qa, setup-db
│       ├── catalog/, products/, categories/, brands/
│       ├── cron/expire-reservations/
│       ├── debug/, notes/, shopping-list/
│       └── payload/[...slug]/
├── lib/                                27 módulos
│   ├── commerce.ts (1184)              dominio puro + tipos + reglas
│   ├── commerce.server.ts (1883)       acceso a datos
│   ├── payment-*.ts                    confirmación / simulación / observabilidad
│   ├── mercadopago*.ts (609+1117+396)  legacy + Orders + identidad
│   ├── notifications.server.ts (646)   Resend
│   ├── kiosk.server.ts, admin.server.ts
│   ├── inventory-*.ts, admin-order-view.ts
│   └── db.ts, env.ts
├── components/                          UI compartida
├── db/migrations/                       001–007 + consolidated + downs
├── migrations/                          Payload (untracked)
├── scripts/                             seed + utilidades + audit-schema
├── tests/                               23 archivos, 250 tests
├── utils/supabase/                      clientes SSR
└── payload.config.ts
```

**Escala:** 124 archivos `.ts/.tsx` en `app/lib/components/utils/scripts/tests`, 28.343 líneas. 34 rutas de API, 14 páginas/layouts.

### Bien separado

- `lib/commerce.ts` (contrato y reglas puras) vs `lib/commerce.server.ts` (datos). La intención es correcta y testeable.
- `lib/payment-confirmation.server.ts`: **un solo embudo** para confirmar un pago. El webhook real y la simulación QA pasan por la misma función.
- `lib/inventory-audit.ts`, `lib/inventory-receipt-plan.ts`, `lib/admin-order-view.ts`: puros, sin I/O, con tests.
- `lib/payment-simulation.server.ts` y `lib/qa-order-cleanup.server.ts`: gates aislados, fail-closed.
- La base es la autoridad: transiciones y stock viven en triggers/funciones SQL, no en JavaScript.

### Mezclado

| Archivo | Qué mezcla |
|---|---|
| `lib/commerce.server.ts` (1883) | pedidos + admin + inventario + pickup + webhook + QA en un solo módulo |
| `lib/db.ts` (161) | driver/connection + repositorio de `product_overrides` |
| `lib/env.ts` (415) | resolución de env + validación + diagnóstico Vercel + presencia de MP |
| `app/api/payments/webhook/route.ts` (522) | firma + llamada a MP + confirmación + correo + observabilidad |
| `app/admin/page.tsx` (1099) | UI + fetch + setup-db + edición de catálogo |
| `app/pedido/[token]/page.tsx` (491) | vista + polling + PIN + pago |
| Catálogo | **tres fuentes**: `lib/products.ts` hardcodeado (421), `product_overrides` en DB, y colecciones Payload que no existen |
| Supabase | dos juegos de clientes (`lib/supabase/*` legacy vs `utils/supabase/*` SSR); `lib/supabase/client.ts` no lo importa nadie |
| Env | `lib/env.ts` y `utils/supabase/env.ts` duplican la resolución de prefijos |

### Archivos demasiado grandes

`commerce.server.ts` 1883 · `commerce.ts` 1184 · `mercadopago-orders.server.ts` 1117 · `admin/page.tsx` 1099 · `notifications.server.ts` 646 · `mercadopago.server.ts` 609 · `payments/webhook/route.ts` 522 · `pedido/[token]/page.tsx` 491 · `admin/kiosco/page.tsx` 473 · `products/page.tsx` 436 · `products.ts` 421 · `env.ts` 415.

### Dependencias cruzadas

```
commerce.server ──> env, commerce, admin-order-view, inventory-audit
payment-confirmation ──> commerce.server, notifications
notifications ──> commerce.server        ← la capa de avisos depende de la de datos
payment-simulation ──> admin.server, commerce.server, payment-confirmation
qa-order-cleanup ──> admin.server, commerce.server, admin-order-view
mercadopago ──> env, commerce (tipos)
db ──> env
kiosk.server ──> env
adminProductStore ──> products, adminAuth
cartStore ──> products, commerce
```

### Peligroso de mover

- `lib/commerce.server.ts` y las funciones SQL: cualquier cambio de driver toca pagos y stock.
- `db/migrations/*`: son la única definición del esquema; no hay runner.
- Las **rutas** (`/api/payments/webhook`, `/api/kiosk/*`, `/pedido/<token>`): están registradas en Mercado Pago y en tablets.
- `middleware.ts` + Supabase: afecta todas las requests.
- `mercadopago*.ts`: congelado por decisión, no por deuda.
- `app/admin/page.tsx`: 1099 líneas sin tests; moverlo a ciegas es caro.

### Debe quedarse como está (temporalmente)

Rutas de `app/`, `middleware.ts`, funciones y triggers SQL, flujo legacy de Mercado Pago, módulo `mp-orders` congelado, panel admin y kiosco.

---

## C. Base de datos actual

### Lo verificado en la base alcanzable

- **PostgreSQL 17.11**, base `neondb`, schema `public` con **12 tablas**, **0 vistas**.
- Extensiones: **solo `plpgsql`**. `gen_random_uuid()` es nativa en PG 17.
- **16 funciones** en `public`, **8 triggers** distintos.
- **RLS habilitado en 8 tablas y 0 políticas** → para el owner no cambia nada; para roles restringidos equivale a denegar todo.
- Schema `neon_auth` con 9 tablas (Auth gestionado por Neon): `user`, `session`, `account`, `organization`, `member`, `invitation`, `verification`, `jwks`, `project_config`. **Vacías salvo `project_config` (1 fila) y sin una sola referencia en el código.**
- **No existen** las 18 tablas de Payload ni `payload_migrations`.
- **No existe** `payment_webhook_events`.

### Tablas

| Tabla | PK | FK / relaciones | Columnas críticas | Índices / constraints | Trigger | Estado | Filas |
|---|---|---|---|---|---|---|---|
| `customers` | `id` uuid | — | email, phone, full_name, auth_user_id, deleted_at | único email vivo, único auth_user | updated_at | **ACTIVO** (sin uso aún) | 0 |
| `orders` | `id` uuid | `customer_id → customers` | order_number, public_token, status, payment_status, totales, reservation_*, metadata, version | únicos number/token/idempotency; índices status/created/contact/expiring; CHECK cuadratura | updated_at + **status guard** | **ACTIVO** | 14 (QA) |
| `order_items` | `id` uuid | `order_id → orders` CASCADE | product_slug, variant_key, quantity, unit_price, line_total | único (order, line); CHECK line_total | updated_at + **lock** | **ACTIVO** | 14 |
| `inventory` | `id` uuid | — | location_code, product_slug, variant_key, on_hand, reserved, `quantity_available` GENERADA | único SKU; CHECK no oversell | updated_at | **ACTIVO** | 49 |
| `inventory_movements` | `id` bigserial | inventory/order/order_item (RESTRICT) | movement_type, deltas, saldos, idempotency_key | único idempotency; índices por inventory/order | **append-only** | **ACTIVO** (ledger) | 74 |
| `pickup_codes` | `id` uuid | `order_id → orders` CASCADE | code, status, attempts, expires_at, redeemed_* | único code; único issued por pedido | updated_at | **ACTIVO** | 4 |
| `pickup_attempts` | `id` | — | device_id, ip, outcome, created_at | índices ventana/dispositivo | — | **ACTIVO / QA** (sin RLS) | 5 |
| `order_status_transitions` | `(from,to)` | — | requires_role, description | CHECK no self | — | **ACTIVO** (matriz) | 19 |
| `order_status_history` | `id` bigserial | `order_id → orders` CASCADE | from/to, changed_by, reason | índice por pedido | — | **ACTIVO** (auditoría) | 22 |
| `product_overrides` | `slug` text | — | `data` jsonb, updated_at | índice updated_at | — | **LEGACY / AMBIGUO** | 0 |
| `categories` | `id` serial | `parent_id → categories` | name, slug, level, sort_order | índices parent/level | — | **AMBIGUO** (vacía) | 0 |
| `brands` | `id` serial | — | name único | único name | — | **AMBIGUO** (vacía) | 0 |
| `payment_webhook_events` | — | — | — | — | — | **NO EXISTE (004 sin aplicar)** | — |
| 18 tablas Payload (`users`, `products`, `notes`, `payload_*`…) | — | — | — | — | — | **NO USADO / NO EXISTE** | — |
| `notes`, `shopping_list_items` (Supabase) | — | — | — | — | — | **AMBIGUO**, fuera de este Postgres | — |

**Nota de colisión real:** `product_overrides` en la base tiene forma **legacy** (`slug` PK + `data` jsonb), que es la que consulta `lib/db.ts`. La colección Payload del mismo nombre espera `id serial + product_id + columnas`. Si algún día se aplica la migración de Payload, **choca**. Lo mismo puede pasar con `categories`/`brands`, aunque hoy sus columnas coinciden por casualidad.

### Funciones y triggers

| Migración | Funciones |
|---|---|
| 001 | `set_updated_at`, `enforce_order_status_transition`, `refresh_order_totals_from_items`, `prevent_ledger_mutation`, `guard_order_items_mutation`, `inventory_apply_movement`, `inventory_reserve_order`, `inventory_release_order`, `inventory_commit_order`, `expire_stale_orders`, `issue_pickup_code`, `redeem_pickup_code` |
| 002 | `inventory_rereserve_order`, `confirm_order_payment` |
| 003 | `issue_pickup_code` (6 dígitos), `redeem_pickup_code_verified`, `mark_order_ready_for_pickup` |
| 005/006/007 | **ausentes en esta base** |

Triggers: `trg_customers_updated_at`, `trg_orders_updated_at`, `trg_orders_status_guard`, `trg_order_items_updated_at`, `trg_order_items_lock`, `trg_inventory_updated_at`, `trg_inventory_movements_append_only`, `trg_pickup_codes_updated_at`.

### Clasificación

- **ACTIVO EN PRODUCCIÓN:** `orders`, `order_items`, `inventory`, `inventory_movements`, `pickup_codes`, `order_status_transitions`, `order_status_history`, `customers`.
- **QA (pero con valor de producción):** `pickup_attempts` (freno de fuerza bruta del PIN), `payment_webhook_events` (falta).
- **LEGACY:** `product_overrides` (forma vieja), `categories`/`brands` (creadas por `setup-db`, vacías, catálogo hardcodeado), Payload completo.
- **AMBIGUO:** `product_overrides` vs colección Payload; `notes`/`shopping_list_items` en Supabase.
- **NO USADO:** schema `neon_auth`, tablas Payload inexistentes, `lib/supabase/client.ts`.

---

## D. Dependencias de Vercel

| Archivo | Uso | Riesgo al migrar a Railway | Cambio recomendado |
|---|---|---|---|
| `lib/env.ts` | `VERCEL_ENV` se valida al importar; `VERCEL_URL`; prefijos `BANGELH_/UMANTAI_URL_/UMANTAI_` | Sin `VERCEL_ENV` cae a `development`; **la validación deja de lanzar en producción** (fail-open) | Usar `resolveRuntimeEnvironment()` y `APP_ENV` |
| `lib/env.ts:137` `isVercelPreview()` | Diagnóstico de routing de notificaciones en `/api/payments/preference` | En Railway siempre `false`: solo desactiva un diagnóstico | Aceptable; migrar a `APP_ENV` si se necesita |
| `app/api/payments/webhook/route.ts:75` | `isProductionRuntime()` local: Vercel → `NODE_ENV` | En Railway `NODE_ENV=production` → modo producción correcto | Reemplazar por helper único |
| `payload.config.ts:28` | Producción = `VERCEL_ENV=production` o (`NODE_ENV=production` sin `VERCEL_ENV`) | En Railway **exige `PAYLOAD_SECRET` en build**; si falta, el build falla | Correcto y deseable; documentar |
| `lib/payment-simulation.server.ts` | Gate `VERCEL_ENV === 'preview'` | **La simulación QA queda 404 en Railway staging** | Gate por `APP_ENV` + flag |
| `lib/qa-order-cleanup.server.ts` | Mismo gate | Limpieza QA inutilizable en Railway | Idem |
| `lib/payment-webhook-support-capture.ts` | Mismo gate | Captura de soporte inutilizable | Idem |
| `app/api/mp-orders/debug/route.ts` | `VERCEL_ENV === 'preview'` | Diagnóstico 404 en Railway | No tocar (congelado) |
| `app/api/mp-orders/create` y `admin/qa/mp-orders` | `isProductionRuntime()` (APP_ENV primero) | **Ya es portable** | Ninguno |
| `vercel.json` `crons` | `/api/cron/expire-reservations` diario 03:00 (límite Hobby) | **Railway no lee `vercel.json`: el cron desaparece** | Cron de Railway cada 15 min con `CRON_SECRET` |
| `vercel.json` `headers` | X-Frame-Options, X-Content-Type-Options, X-XSS-Protection | **Se pierden** | Mover a `next.config.ts` |
| `vercel.json` `functions.maxDuration` | 30 s | No aplica | Ninguno |
| `vercel.json` `regions: iad1` | Latencia | Elegir región Railway cercana a Perú/Neon | Decidir en Fase B |
| Prefijos `BANGELH_/UMANTAI_URL_/UMANTAI_` | Integraciones Vercel | En Railway no existen; el código igual acepta nombres directos | Usar nombres canónicos |
| `app/debug/env`, `EnvironmentStatus` | Muestran `VERCEL_*` y “run vercel env pull” | Cosmético/confuso | Ajustar después |
| `next.config.ts` `NEXT_PUBLIC_SERVER_URL` | Declarada y **no usada** | Ninguno | Eliminar o usar |
| `MERCADOPAGO_BACK_URL_BASE` / `resolveOrigin` | Usa `MERCADOPAGO_BACK_URL_BASE`, si no `x-forwarded-host`, si no `nextUrl.origin` | Railway pasa `x-forwarded-*`; igual conviene fijar la variable | Fijar dominio staging |
| `wrangler.toml`, `build:cloudflare`, OpenNext | Target Cloudflare histórico | Ruido, no bloquea | Limpiar en Fase I |

---

## E. Dependencias de Neon

| Aspecto | Estado |
|---|---|
| Construcción de URL | `POSTGRES_URL_NON_POOLING` → `POSTGRES_URL` → `DATABASE_URL`, con prefijos Vercel. `lib/db.ts`, `lib/commerce.server.ts`, `payload.config.ts` |
| Driver principal | `@neondatabase/serverless` → **HTTP** (`neon(url)`) en `lib/db.ts` y `lib/commerce.server.ts` |
| Driver secundario | Payload usa `@payloadcms/db-postgres` (drizzle + **`pg` Pool** TCP). Ese sí es portable |
| Transacciones | `sql.transaction([...])` **batch HTTP** en **8 lugares** de `commerce.server.ts` (crear pedido, transición, cancelar, listados, kiosco) |
| Pool / conexiones | El driver HTTP no mantiene pool. Payload abre un pool TCP por instancia (default ~10) |
| SSL | Neon lo exige. Railway en red privada **no** usa SSL; el proxy público sí |
| Migraciones | **No hay runner**. Se aplican a mano con `psql` o el SQL Editor. Payload tiene su carpeta `migrations/` untracked y sin aplicar |
| Funciones | 17 PL/pgSQL estándar |
| Extensiones | Solo `plpgsql`. Sin `pgcrypto`, sin `uuid-ossp`, sin PostGIS |
| Branches Neon | No se usan desde el código. No se pudieron enumerar sin la API/consola |
| Neon Auth | Schema `neon_auth` **gestionado por Neon**, vacío y sin uso. **No es portable** tal cual |
| Portabilidad del esquema | **Alta**: PG 17 estándar, sin features propietarias |
| Portabilidad de la aplicación | **Baja**: el driver HTTP de Neon **no funciona contra Railway Postgres** |

**Consecuencia:** migrar a Railway no es “cambiar una URL”. `neon(url)` habla HTTP contra el endpoint `/sql` de Neon; un Postgres común no expone eso. Hay que sustituir el cliente en **2 archivos, ~60 consultas y 8 transacciones**, o introducir una abstracción que mantenga dos adaptadores.

---

## F. Riesgos de migración

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Pérdida de datos en el cutover | Baja | **Crítico** | `pg_dump` verificado + restore drill + congelar escrituras durante el flip |
| Migración incompleta de esquema (004–007 ausentes en la base QA) | **Alta** | **Crítico** | Reconciliar antes de copiar; fingerprint de esquema; aplicar 004→007 **sobre la copia** |
| Driver Neon HTTP incompatible con Railway | **Alta** | **Crítico** | Adaptador `pg` detrás de flag, con los 250 tests y smoke de pagos/stock |
| Funciones SQL incompatibles | Baja | Medio | Mismo PG 17, sin extensiones; comparar `pg_get_functiondef` |
| Variables específicas de Vercel | Alta | Alto | `APP_ENV` como señal primaria; gates migrados |
| Validación de env fail-open fuera de Vercel | Media | Alto | `validateEnvironment()` debe usar el helper de runtime |
| URLs de callbacks / webhook | Media | Alto | Dominio staging estable + `MERCADOPAGO_BACK_URL_BASE`; no reutilizar credenciales live |
| Mercado Pago (Orders congelada / webhook legacy) | Media | Alto | No tocar; usar app de prueba; no crear Orders |
| Auth | Media | Alto | Hoy no hay login; decidir Supabase vs Better Auth/Neon Auth **antes** de multi-tienda |
| Uploads | Baja | Bajo | No hay uploads hoy |
| Payload | Media | Medio | No está montado ni provisionado; eliminarlo en una tarea aparte |
| Conexiones PostgreSQL | Media | Medio | Pool dimensionado, `max_connections`, monitoreo |
| Rollback | Media | Alto | Vercel + Neon intactos 30 días; DNS con TTL bajo; runbook |
| Multi-tenant data leaks | Media | **Crítico** | `store_id` + RLS + tests de aislamiento antes de vender multi-tienda |
| Doble pago / stock inconsistente | Media | **Crítico** | Aplicar 005/006/007; tests de integración reales |
| Pérdida del cron | Alta | Medio | Cron de Railway + `CRON_SECRET` |
| Correo con remitente de pruebas | Alta | Medio | Verificar dominio en Resend |
| Rama de Producción ambigua (`main` viejo) | Alta | Medio | Etiquetar el commit actual; confirmar rama en Vercel |

---

## G. Arquitectura objetivo en Railway

```
Railway Project: UMANTAI
├── Environment: staging
│   ├── web          (Next.js 16, Node 22, 1 réplica)
│   ├── postgres     (PostgreSQL 17, volumen)
│   └── cron         (servicio programado, cada 15 min)
└── Environment: production   ← se crea recién en Fase H
    ├── web
    ├── postgres
    └── cron
```

| Elemento | Definición |
|---|---|
| Servicio web | Repo `Bangelh/umantai`, rama `release/railway-staging`; build `npm ci && npm run build`; start `npm run start`; healthcheck `/` (luego `/api/health`) |
| PostgreSQL | Servicio gestionado PG 17, volumen persistente, red privada |
| Variables | `POSTGRES_URL_NON_POOLING=${{Postgres.DATABASE_URL}}`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `APP_ENV=staging`, `PAYLOAD_SECRET`, `ADMIN_API_SECRET`, `KIOSK_ACCESS_CODE`, `CRON_SECRET`, `MERCADOPAGO_*` de la app de prueba, `RESEND_*`, Supabase si se conserva, `COMMERCE_RESERVATION_TTL_MINUTES=30` |
| Staging | Entorno y base **separados** de Producción. Nunca la misma DB |
| Producción futura | Entorno separado, `APP_ENV=production`, dominio propio |
| Backups | `pg_dump` programado a R2/S3 + snapshot del volumen. **No asumir PITR**: verificarlo en el plan contratado |
| Healthcheck | `/` al inicio; agregar `/api/health` (DB + versión) en la primera tanda de código |
| Logs | Logs de Railway; retención según plan; mantener logs de Vercel durante la ventana de rollback |
| Storage | No hace falta hoy. Futuro: R2/S3 para imágenes; no volumen para `web` |
| Dominio | `staging.umantai.com` (CNAME). El apex **no se toca** hasta el cutover |
| Rollback | DNS de vuelta a Vercel + Neon intacto. TTL bajo antes del cutover |

**Trampa de build:** en Railway, `next build` corre con `NODE_ENV=production` y sin `VERCEL_ENV`. `payload.config.ts` lo interpreta como producción y **lanza si falta `PAYLOAD_SECRET`**. Hay que definir el secreto también en staging.

---

## H. Plan de migración paso a paso

### FASE A — Backup / snapshot / export

1. Congelar despliegues y anotar el SHA de Producción.
2. `pg_dump` con formato custom usando la conexión **directa** (no pooled).
3. Exportar también `--schema-only` y un snapshot de conteos (por tabla) y de definiciones de funciones/triggers.
4. Calcular checksum del dump y guardarlo en dos destinos.
5. **Restore drill** en una base scratch y comparar conteos + fingerprint.

**Salida:** dump restaurable demostrado. Sin esto no se avanza.

### FASE B — PostgreSQL de staging en Railway

1. Crear proyecto/entorno staging y servicio Postgres 17.
2. Verificar `server_version`, timezone, `max_connections`, extensiones y que el volumen esté adjunto.
3. Definir backup programado.

**Salida:** base vacía, accesible y respaldada.

### FASE C — Migrar una COPIA de datos

1. `pg_restore` del dump en staging (nunca al revés).
2. Comparar conteos exactos y fingerprint.
3. No conectar todavía la app.

**Salida:** copia íntegra.

### FASE D — Aplicar / verificar esquema

1. Diff de esquema origen vs copia (tablas, columnas, índices, constraints, funciones, triggers).
2. Aplicar en la copia las migraciones **004 → 007** que faltan, en orden, y volver a comparar.
3. Documentar cualquier divergencia (Payload, `product_overrides`, `neon_auth`).

**Salida:** esquema reconciliado y reproducible desde `db/migrations`.

### FASE E — Conectar una rama staging de la app

1. Crear rama `release/railway-staging`.
2. Introducir la abstracción de driver (`pg`) **sin cambiar comportamiento** y con Neon como default.
3. Variables de staging; `APP_ENV=staging`.
4. Deploy a Railway staging.

**Salida:** app arriba contra la copia.

### FASE F — Smoke tests

Home, catálogo, disponibilidad, carrito, `/api/orders`, `/pedido/<token>`, admin, kiosco, cron, login de admin por token.

### FASE G — Validación funcional

Storefront, products, cart, orders, inventory, kiosk, admin, emails, auth, MP **solo no destructivo** (Preference en sandbox; **nada de Orders**).

### FASE H — Decidir cutover

Solo si: 0 diferencias de conteo, checklist completo, 7 días de staging estable, backup verificado y runbook de rollback probado.

### FASE I — Mantener Vercel/Neon como rollback temporal

30 días sin borrar nada. Neon en solo lectura lógica (no rotar credenciales, no borrar ramas). Vercel sin nuevos deploys.

---

## I. Plan de reorganización del repositorio

```
umantai/
  app/            (storefront) admin/ api/
  modules/
    catalog/ inventory/ orders/ payments/ pickup/
    stores/ analytics/ customers/ subscriptions/
  db/ migrations/ queries/ functions/ seeds/
  lib/ components/ tests/ docs/ scripts/
```

| Área | Clasificación | Cuándo / cómo |
|---|---|---|
| `docs/` (propuestas comerciales) | **NO MOVER** | Está en `.gitignore`; no se versiona |
| `tests/` y `scripts/` | **MOVER AHORA** | Reubicación mecánica, sin cambios de código |
| `db/migrations` + `db/functions` + `db/seeds` | **MOVER AHORA (solo carpetas)** | Los `.sql` no se editan; solo se agrupan |
| `lib/products.ts` → `modules/catalog` | **MOVER DESPUÉS** | Requiere decidir la fuente del catálogo (código vs DB) |
| `lib/commerce.ts` → `modules/commerce/domain` | **MOVER DESPUÉS** | Es el contrato de todo; un PR exclusivo |
| `lib/commerce.server.ts` → `modules/{orders,inventory,pickup,payments}` | **MOVER DESPUÉS** | Partir por agregado, un dominio por PR, con tests |
| `lib/mercadopago*` → `modules/payments` | **MOVER DESPUÉS** | Primero descongelar Orders |
| `lib/notifications` → `modules/notifications` | **MOVER DESPUÉS** | Romper la dependencia con `commerce.server` |
| `app/` (rutas) | **NO MOVER TODAVÍA** | Es la superficie pública y los webhooks registrados |
| `middleware.ts` | **NO MOVER TODAVÍA** | Afecta todas las requests |
| `lib/db.ts` | **MOVER DESPUÉS** | Se reemplaza por el adaptador de driver |
| `mp-orders` | **NO MOVER TODAVÍA** | Congelado |
| Payload (`payload.config.ts`, `migrations/`) | **NO MOVER TODAVÍA** | Eliminación planificada, no refactor |

**Orden seguro:** (1) carpetas de docs/scripts/tests; (2) adaptador de driver; (3) partir `commerce.server` por dominio; (4) catálogo; (5) payments/MP; (6) limpieza Payload/Cloudflare. **Nunca** en el mismo commit que una feature.

---

## J. Preparación para Multi-Tienda

| Entidad | `store_id` | Alcance | Notas |
|---|---|---|---|
| `Store` | — (raíz) | Global | Nueva |
| `StoreUser` | ✅ | Por tienda | `(store_id, user_id)` único + rol |
| `MasterProduct` | ❌ | Global | SKU canónico, marca, atributos |
| `StoreProduct` | ✅ | Por tienda | precio, visibilidad, nombre local; único `(store_id, master_product_id)` |
| `Inventory` | ✅ | Por tienda | único `(store_id, product, variant)`; `location_code` pasa a pertenecer a la tienda |
| `InventoryMovement` | vía `inventory_id` (opcional denormalizar) | Por tienda | El ledger no se comparte |
| `Order` | ✅ **NOT NULL** | Por tienda | `order_number` por tienda (secuencia distinta o prefijo) |
| `OrderItem` | vía `order_id` (opcional denormalizar) | Por tienda | Snapshot del `store_product` |
| `PickupCode` | vía `order_id` | Por tienda | `locker_code` por tienda |
| `Customer` | ❌ global + `StoreCustomer` | Identidad global, relación por tienda | PII no se cruza; consentimiento por tienda |
| `PaymentAccount` | ✅ | Por tienda | credenciales MP cifradas por tienda |
| `Subscription` / `Plan` | ✅ / plan global | Por tienda | El plan puede ser catálogo global |
| `Analytics` | ✅ | Por tienda | Agregados aislados |

**No deben cruzarse jamás:** pedidos e ítems, PII de clientes, stock y movimientos, credenciales de pago y secretos de webhook, códigos de kiosco, correos y analítica.
**Globales:** países/monedas, `MasterProduct`, taxonomía de marcas, catálogo de planes.
**Compartido con scoping estricto:** categorías (taxonomía global + override por tienda), imágenes.

**Lo que hoy bloquea multi-tienda:** no existe `Store`; el catálogo está en código; `order_number_seq` es global; `product_overrides` es global por slug; RLS está habilitado sin políticas; no hay auth de usuarios real.

---

## K. Backup y rollback

**Antes de migrar**

- `pg_dump` custom + schema-only + conteos + definiciones de funciones.
- Guardar en dos destinos con checksum.
- **Probar la restauración** en una base scratch y comparar conteos/fingerprint.
- Verificar que el dump incluya: datos, secuencias (`order_number_seq`), funciones, triggers, índices y constraints.

**Cómo comprobar que sirve**

- Restaurar en limpio y ejecutar el fingerprint: 12 tablas, 16 funciones, 8 triggers, mismos conteos.
- Probar una operación real sobre la copia: crear pedido → reservar stock → cancelar → liberar.

**Restaurar**

- `pg_restore --clean --if-exists --no-owner` sobre una base vacía, nunca sobre Producción.
- Si hay que volver: restaurar el dump en Neon (o mantener la rama intacta) y repuntar la app.

**Ventana**

- Vercel + Neon **30 días** mínimo después del cutover.
- No borrar: proyecto Vercel, rama Neon, dominio, secretos, cron.

**Condiciones de rollback**

- Cualquier diferencia de stock/pedidos, error de pago, webhook caído, kiosco inoperante o emails fallando de forma sistémica.
- Decisión con datos: conteos, logs, checklist.

---

## L. Checklist de QA de la migración

| # | Check | Criterio |
|---|---|---|
| 1 | App inicia | Healthcheck 200 |
| 2 | DB conecta | Query real + `/debug/env` sin errores |
| 3 | Catálogo carga | Mismos productos y precios |
| 4 | Stock coincide | Conteo y `quantity_available` idénticos al origen |
| 5 | Carrito funciona | Alta/baja/cambio de variante |
| 6 | Crear pedido | 201 + reserva de stock |
| 7 | Reservas | `inventory_movements` con `reservation` |
| 8 | Cancelar libera stock | `release` + `reserved` vuelve |
| 9 | Kiosco | Cola, preparar, PIN |
| 10 | PIN | Canje OK; PIN inválido bloquea; intentos limitados |
| 11 | Admin | Token, inventario, pedidos, overrides |
| 12 | Emails | Resend entrega; fallo no rompe el pedido |
| 13 | Auth | Admin/kiosco con sus claves; sin acceso anónimo |
| 14 | Sin duplicados | `orders`/`order_items`/`movements` sin filas repetidas |
| 15 | Conteos antes/después | Iguales tabla por tabla |
| 16 | Funciones | 005/006/007 presentes y probadas |
| 17 | Cron | Libera vencidos con `CRON_SECRET` |
| 18 | Webhook MP | Firma válida; sandbox no confirma en producción |

---

## M. Qué podemos ejecutar YA

- Confirmar la rama de Producción en Vercel y **etiquetar** el commit actual.
- Crear el proyecto/entorno **staging** de Railway y su Postgres (sin tocar Producción).
- Tomar el backup y hacer el restore drill.
- Copiar la base a staging y correr el fingerprint.
- Escribir el adaptador de driver en una rama, con Neon como default.
- Agregar `/api/health` y mover los headers de `vercel.json` a `next.config.ts`.
- Documentar el runbook de rollback.

## N. Qué NO debemos ejecutar todavía

- Migrar Producción, cambiar DNS o el dominio.
- Borrar Vercel, Neon, ramas, tablas o código legacy.
- Tocar Mercado Pago, Preferences, Orders, webhooks o credenciales live.
- Iniciar Multi-Tienda o escribir sus migraciones.
- Refactor masivo o mover `app/`, `middleware` o SQL.
- Aplicar 004–007 en Producción sin backup verificado y ventana definida.
- Mezclar migración + features + multi-tienda en un commit.

---

## O. Veredicto

1. **¿Listos para crear Railway staging?** **Sí.** Es aditivo y no toca nada. Condiciones: entorno separado, credenciales de prueba, `PAYLOAD_SECRET` desde el build, región decidida y backup configurado.
2. **¿Listos para copiar la DB?** **Sí, para una copia a staging; no para cutover.** La copia es segura si existe un backup verificado. La copia heredará el esquema incompleto (004–007 ausentes), así que hay que reconciliarlo **en la copia** antes de probar pagos.
3. **¿Qué bloquea la migración?** El driver HTTP de Neon (código), el estado real del esquema de Producción, los gates atados a `VERCEL_ENV`, la validación de env fail-open, el cron/headers de Vercel y la ambigüedad de la rama de Producción.
4. **¿Qué cambios hay que hacer antes?** Adaptador de driver; gates por `APP_ENV`; validación de env con el helper de runtime; headers en `next.config`; cron en Railway; `/api/health`; reconciliación 004–007; decisión explícita sobre el catálogo y sobre auth.
5. **¿Riesgo más alto?** **Inconsistencia de datos transaccionales** (pago/stock) al combinar un driver nuevo con un esquema que no tiene las guardas 005/006/007. Probabilidad media, impacto crítico.
6. **¿Primer cambio real?** Un **adaptador de base de datos** (`pg`) detrás de un flag, con Neon como comportamiento por defecto y los 250 tests verdes. Antes de eso, solo backup y staging.

---

## Anexo — Evidencia y reproducibilidad

- `scripts/audit-schema.ts` obtiene el fingerprint read-only (transacción `READ ONLY`), conteos y presencia de 001–007.
- `tests/audit-schema.test.ts` cubre la lógica pura (redacción, fingerprint determinista, detección de migraciones, guardas).
- Verificación final con las pruebas nuevas: `npm test` **270/270**; `eslint` de los archivos nuevos **0 errores**; `tsc` mantiene **sólo** los 2 errores preexistentes del directorio untracked `migrations/`.
- El fingerprint **no incluye conteos**: compara esquema. Los conteos se informan aparte y se comparan manualmente.
- `RAILWAY_STAGING.md` define el entorno objetivo y las variables; **no** crea servicios ni conecta la app.
- `railway.json` fija build/start/healthcheck para cuando se cree el servicio.

**Acciones de cierre ejecutadas:** informe persistido, tag `pre-railway-2026-10-19` sobre `408a8f5`, script de auditoría y tests. No se modificó Producción, ni Mercado Pago, ni el driver, ni se aplicaron migraciones, ni se copió la base.
