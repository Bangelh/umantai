# Railway staging — estado funcional (2026-10-19)

**Proyecto:** UMANTAI (`9128fbe3-a6b9-4a42-9fb6-407d3c74236f`)
**Entorno:** `staging` (`c19f1bca-5aba-4eaf-8117-20761a6e9d37`) — el entorno
`production` del proyecto Railway quedó **vacío**, sin servicios ni deploy.
**URL:** https://web-staging-6756.up.railway.app
**Commit desplegado:** `c96e9dd` (rama `feat/railway-staging`)

> No se tocó Vercel/Neon productivos, DNS, Mercado Pago ni se hizo merge a `main`.

---

## 1. Servicios

| Servicio | Detalle |
|---|---|
| `web` | App Next.js 16, builder Nixpacks, Node 22, healthcheck `/api/health` |
| `Postgres17` | **PostgreSQL 17.11**, imagen `postgres:17`, volumen `postgres17-volume` montado en `/var/lib/postgresql/data` |
| `cron` | Mismo repo, `startCommand=node scripts/trigger-expire-reservations.mjs`, schedule `*/15 * * * *` |
| `Postgres` | PostgreSQL 18 creado por la template por defecto; quedó **sin uso** (no se borra sin aprobación) |

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
- Headers: `x-content-type-options`, `x-frame-options`, `x-xss-protection`.
- Integración real contra `umantai_integration` (Railway PG17):
  **8/8 tests**.

## 6. Pendiente / riesgos

- La template `--database postgres` creó **PG18**; se agregó un `Postgres17`
  aparte. El servicio PG18 sigue existiendo sin uso (no se borra sin aprobación).
- El cron se configuró vía API de Railway (`serviceInstanceUpdate`); verificar la
  primera ejecución programada en el dashboard.
- `web` no tiene `NEXT_PUBLIC_SUPABASE_*`; las funciones de notas/listas quedan
  inactivas (el resto del comercio funciona).
- Sin credenciales de prueba de Mercado Pago: el checkout queda 503 y no se creó
  ninguna Preference/Order.
