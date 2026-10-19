# Railway staging — estado funcional (2026-10-19)

**Proyecto:** UMANTAI (`9128fbe3-a6b9-4a42-9fb6-407d3c74236f`)
**Entorno:** `staging` (`c19f1bca-5aba-4eaf-8117-20761a6e9d37`) — el entorno
`production` del proyecto Railway quedó **vacío**, sin servicios ni deploy.
**URL:** https://web-staging-6756.up.railway.app
**Commit de runtime desplegado:** `0c261cc5330759d6d70dccd16a10ae18d8466192`
(`feat/railway-staging`), verificado en `/api/health` → `commit` y
`build { buildId, commitSource: "GIT_COMMIT_SHA", builtAt }`.
El SHA se inyecta como `GIT_COMMIT_SHA` antes de cada `railway up`, porque el
deploy por archivo no lo expone. Desde la Fase 2, `npm run build` sella además un
manifiesto embebido (`lib/build-info.generated.json`), así que el health identifica
el build aunque la variable de plataforma quede desfasada.

> No se tocó Vercel/Neon productivos, DNS, Mercado Pago ni se hizo merge a `main`.

---

## 1. Servicios

| Servicio | Detalle |
|---|---|
| `web` | App Next.js 16, builder Nixpacks, Node 22, healthcheck `/api/health` |
| `Postgres17` | **PostgreSQL 17.11**, imagen `postgres:17`, volumen `postgres17-volume` montado en `/var/lib/postgresql/data` |
| `cron` | Mismo repo, `buildCommand=echo cron: no build required` (no compila Next), `startCommand=node scripts/trigger-expire-reservations.mjs`, schedule `*/15 * * * *` |
| `Postgres` | PostgreSQL 18 creado por la template por defecto. **Ningún servicio lo referencia**, pero contiene copias de QA (`railway` y `umantai_restore_drill`). No se borra sin aprobación |

Variables del `web` (sin valores): `APP_ENV=staging`, `DB_DRIVER=pg`,
`PGPOOL_MAX=10`, `COMMERCE_RESERVATION_TTL_MINUTES=30`, `PAYLOAD_SECRET`,
`ADMIN_API_SECRET`, `KIOSK_ACCESS_CODE`, `CRON_SECRET`, `MP_PAYMENT_SIMULATION=1`,
`QA_CLEANUP=1`, `NEXT_PUBLIC_SERVER_URL`, `POSTGRES_URL_NON_POOLING`,
`DATABASE_URL`. **No** se definió `VERCEL_ENV` ni credenciales live de pago.

## 2. Origen del backup

Producción **no tiene datos** (ver `PRODUCTION_BASELINE.md` §8). El origen
verificado es la base QA/Preview de `.env.local`:

- `pg_dump` 18 (ejecutado dentro del contenedor Postgres de Railway, sin sacar la
  URL al host) contra Neon QA.
- Formato **custom** + dump **schema-only**.
- Tamaños y SHA-256:

| Archivo | Bytes | SHA-256 |
|---|---:|---|
| `backups/qa.dump` | 106.518 | `b26d101a5c8da6704dda98c7d0a6be8f6909a06ea9662ce77f66096a3e5dd1d7` |
| `backups/qa-schema.dump` | 86.951 | `f9c98b3b1d0e723ef83df8fd80e0d48a85589245d8cfc31c8d8d7ee80e9de3fe` |

Los backups contienen datos y están en `backups/` (gitignored).

## 3. Verificación del backup

1. Restore en `umantai_verify` (Railway PG17) con `pg_restore --exit-on-error`.
2. Auditoría READ ONLY local contra esa base:
   - fingerprint **`sha256:bea7529f6fca4a84177bf4fc6269e47948f569785fea6d15c665a07674064cb8`**
   - idéntico al origen QA (`audit-qa.json`).
   - 12 tablas, 16 funciones, 8 triggers, 43 índices, 52 constraints.
   - conteos idénticos: 14 orders, 14 order_items, 49 inventory,
     74 inventory_movements, 5 pickup_attempts, 4 pickup_codes.
3. Restore en la base principal `railway` del PG17 staging: 14 órdenes, 12 tablas.

Artefacto: `audit-staging-pre-migrations.json`.

## 4. Migraciones 004–007 (solo staging)

Aplicadas una por una con `psql -v ON_ERROR_STOP=1`, verificando marcadores:

| Migración | Verificación |
|---|---|
| 004 | `payment_webhook_events` existe |
| 005 | `duplicatePayment` en `confirm_order_payment` |
| 006 | `order_requires_review` en las 3 funciones (3/3) |
| 007 | `prior_releases` en `inventory_release_order` |

Fingerprint post-migraciones:
**`sha256:45b59079facadc74632c8eed6d25adce8529c79287a60fc335d678370289e8e5`**
(13 tablas, 16 funciones, 8 triggers, 46 índices, 53 constraints; las 7
migraciones `OK`). Conteos de negocio sin cambios; `payment_webhook_events=0`.

Artefacto: `audit-staging.json`. Detalle: `MIGRATIONS_004_007.md`.

## 5. Confirmación técnica

- `/api/health` → `200 {"ok":true,"environment":"staging","database":{"reachable":true,"type":"pg"}}`.
- `/api/categories` → 200 (Payload contra PG17).
- `/api/catalog/availability` → 200.
- `POST /api/orders` → 201, pedido `UM-2026-001017`, total 299; stock reservado
  (`on_hand=312, reserved=1, available=311`).
- `GET /api/cron/expire-reservations` con `CRON_SECRET` → 200; sin token → 401.
- Ejecución real del servicio `cron` (`railway cron run`): `EXITED` en 6 s con
  `[cron] ok {"ok":true,"expiredOrders":0}`. Programado cada 15 min.
- Headers: `x-content-type-options`, `x-frame-options`, `x-xss-protection`.
- Integración real contra un **clon de la base staging** (`umantai_drill_20261019`,
  creado con `pg_dump | pg_restore` dentro del contenedor PG17): **8/8 tests**.
  Fingerprint del clon después de los tests:
  `sha256:45b59079…` (idéntico a staging); 001–007 `OK`.
  Artefacto: `audit-drill-clone.json`.
- `GET /api/notes` con token admin → **503** `Supabase is not configured`
  (degradación esperada, ya no rompe el build).

### 5.1 Evidencia del deploy d5042b4 (2026-10-19)

- Auditoría READ ONLY de `railway` post-deploy: fingerprint
  `sha256:45b59079…`; 13 tablas, 16 funciones, 8 triggers, 46 índices,
  53 constraints; 001–007 `OK`. Artefacto: `audit-railway-current.json`.
- Conteos: `orders=15`, `order_items=15`, `inventory=49`,
  `inventory_movements=79`, `order_status_history=26`, `pickup_codes=4`,
  `pickup_attempts=5`, `payment_webhook_events=1`.
- Secuencias: `order_number_seq=1017`, `inventory_movements_id_seq=79`,
  `order_status_history_id_seq=26`, `pickup_attempts_id_seq=5`.
- Restore drill original: `umantai_verify` conserva el fingerprint
  `sha256:bea7529f…` (idéntico a QA), 12 tablas, 14 pedidos y las mismas
  secuencias (74 / 1016 / 22 / 5). Artefacto: `audit-umantai_verify-current.json`.

### 5.2 Fase funcional 1 — compra + inventario (2026-10-19)

- Migración **008** aplicada en `railway` (índices del ledger); 001–007 intactas.
- Deploy `a129bfa` verificado en `/api/health`.
- Unitarios: **307/307**. Integración real: **14/14** contra
  `umantai_integration`, que ahora se **resetea y reaplica 001–008** en cada
  corrida (sin datos de corridas previas).
- Smoke de API:
  - `POST /api/admin/inventory/receipts` → 201; `oura-ring-gen3`
    (`color:stealth`) pasó de 312 a 314, umbral 4, movimiento `receipt`.
  - `POST /api/admin/inventory/adjustments` → 200; −1 dejó 313 e informó
    `before/after`. Un −9999 devolvió **409** (invariante).
  - `GET /api/admin/inventory/ledger?product=oura-ring-gen3&type=adjustment`
    devolvió el movimiento con actor, motivo y saldo.
  - `POST /api/orders` → 201 (`UM-2026-001018`), reserva 1/66 disponibles;
    expiración forzada + cron → reserva liberada (0/67) y pedido `expired`.
- `/admin/inventario`, `/cart` y `/products` responden 200.
- Confirmación de compra muestra subtotal y total; verificado en el bundle
  desplegado (`app/cart/page-*.js` contiene la fila `Subtotal`).
- ~~Nota: `/api/health` toma `commit` de `RAILWAY_GIT_COMMIT_SHA`…~~ **Resuelto en
  Fase 2**: el commit y el `buildId` se sellan al compilar (ver §5.3).

### 5.3 Fase funcional 2 — analytics + legal + frontend (2026-10-19)

- Migraciones **009** (`idx_orders_created_at`) y **010** (`contact_messages`)
  aplicadas en `railway` con `psql -v ON_ERROR_STOP=1` desde el contenedor
  `Postgres17`. 001–008 intactas. Idempotentes (`IF NOT EXISTS`).
- Deploy `0c261cc` (`SUCCESS`). `/api/health` → 200 con
  `commit=0c261cc…`, `buildId=20261019193732-0c261cc`,
  `commitSource=GIT_COMMIT_SHA`, base `reachable=true`.
- Smoke público (200): `/`, `/products`, `/products/<slug>`, `/cart`, `/admin`,
  `/admin/inventario`, `/admin/analytics`, `/contacto`, `/legal`,
  `/legal/{privacidad,terminos,reembolsos,cookies,aviso-legal}`,
  `/sitemap.xml`, `/robots.txt`, `/api/health`.
- API analytics:
  - sin token → **401**;
  - con `ADMIN_API_SECRET` (desde el contenedor `web`, sin exponer el valor) →
    **200** con `sales.orders=4`, `revenueCents=144800`, `topProducts=3`,
    `lowStock=1`, `outOfStock=0`, `series.weekly=6`, `currency=PEN`.
- Contacto:
  - payload inválido → **400** con errores por campo;
  - payload válido → **200** `delivery=stored_email_failed` (sin Resend en
    staging), fila guardada en `contact_messages` con `email_status=not_configured`;
  - la fila de QA se borró: `contact_messages` queda en **0 filas**.
- SEO: `robots.txt` bloquea `/admin`, `/api/`, `/debug`, `/kiosk`, `/pedido/`,
  `/cart`, `/list` y publica el sitemap; `sitemap.xml` incluye home, catálogo,
  contacto, legal y todos los productos base.
- Legal: las páginas muestran `[PENDIENTE: …]` para razón social, RUC, dirección,
  correo legal, jurisdicción y plazo de reembolso. No se inventó ningún dato.
- Unitarios **349/349**; integración real (PostgreSQL efímero) **19/19**.
- Limitación de verificación: no hay Chrome/Playwright en el entorno, así que el
  chequeo responsive se hizo por CSS/layout (breakpoints y nav inferior) y smoke
  HTTP, no con viewport automatizado.

## 6. Pendiente / riesgos

- La template `--database postgres` creó **PG18**; se agregó un `Postgres17`
  aparte. El PG18 no lo referencia ningún servicio, pero guarda copias de QA y
  un drill de restore (ver `INFRASTRUCTURE_FOUNDATION.md` §7). No se borra.
- El cron se configuró vía API de Railway (`serviceInstanceUpdate`). El primer
  build falló porque compilaba la app completa sin `PAYLOAD_SECRET`; se fijó un
  `buildCommand` no-op y se verificó una ejecución real.
- `web` no tiene `NEXT_PUBLIC_SUPABASE_*`; las funciones de notas/listas quedan
  inactivas (el resto del comercio funciona).
- Sin credenciales de prueba de Mercado Pago: el checkout queda 503 y no se creó
  ninguna Preference/Order.
- `/admin/analytics` comparte el mismo token que el resto del panel (sin roles):
  quien tenga `ADMIN_API_SECRET` ve agregados de ventas. Se resuelve con auth real.
- El envío de correo del formulario de contacto queda inactivo hasta configurar
  `RESEND_API_KEY` + `CONTACT_TO_EMAIL`; los mensajes igual se guardan.
