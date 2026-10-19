# Producción — baseline verificado y accesos

**Fecha:** 2026-10-19
**Rama de trabajo:** `feat/railway-staging` @ `e4d39ad`
**Tag de congelamiento:** `pre-railway-2026-10-19` → `408a8f5`

> **Regla:** este documento no contiene valores de variables ni credenciales.
> Sólo nombres, commits y hechos verificables desde Git.

---

## 1. Lo que se pudo verificar (Git)

| Dato | Valor |
|---|---|
| Rama de Producción (según Vercel) | **`main`** (confirmado por el usuario) |
| Último commit desplegado explícito | **`c402b9705481e7e06e96c7b8cc8585834e33867b`** |
| Fecha de ese commit | **2026-06-03 19:11:52 -0700** |
| Mensaje | `ui(db-status): use amber inline '⚠️ Connection pooler detected' badge in EnvironmentStatus + debug page` |
| Tip actual de `main` | **`4496551`** — 2026-06-04 — `chore: trigger Vercel auto-deployment with correct author` |
| HEAD de la rama nueva | **`e4d39ad`** |
| Distancia Producción → HEAD | **56 commits**, 126 archivos, +27.908 / −374 |
| Tag pre-Railway | `408a8f5` (intacto) |

Producción visible = **`main`**, con dos candidatos de commit: `c402b97`
(último cambio funcional reportado) y `4496551` (commit de redeploy). La
diferencia entre ambos es sólo el mensaje/trigger de deploy; conviene tratar
`4496551` como el tip real de la rama.

## 2. Lo que NO se pudo verificar (falta de acceso)

| Dato | Estado | Motivo |
|---|---|---|
| Deployment ID de Production | **NO VERIFICADO** | Vercel CLI está **logged out** y no hay `VERCEL_TOKEN` en el entorno |
| Fecha exacta del deployment actual | **NO VERIFICADO** | idem |
| Variables presentes por nombre en Production | **NO VERIFICADO** | idem |
| Valor/URL de la DB de Production | **NO VERIFICADO** | idem |
| Rama configurada en Vercel | **Confirmada por el usuario**, no por API | idem |

Evidencia de la CLI:

```
$ npx vercel whoami
Vercel CLI 64.5.0
> Logged out.
```

No existe `.vercel/project.json` en el repo ni token en el entorno. No se
modificó ninguna configuración de Vercel.

## 3. Variable de DB que usa el código

Orden de resolución (idéntico en `lib/db.ts`, `lib/commerce.server.ts`,
`payload.config.ts` y `lib/env.ts`):

1. `POSTGRES_URL_NON_POOLING` (y variantes prefijadas `BANGELH_`,
   `UMANTAI_URL_`, `UMANTAI_`)
2. `POSTGRES_URL`
3. `DATABASE_URL`

**Conclusión:** si Production tiene más de una definida, el código usa
`POSTGRES_URL_NON_POOLING`. No se puede saber cuál está definida sin acceso a
Vercel. `POSTGRES_PRISMA_URL` sólo se reporta en diagnóstico; no se usa para
consultar.

## 4. Nombres de variables que el código actual lee

Sólo nombres. No se verificó su presencia en Production.

| Área | Variables |
|---|---|
| DB | `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL`, `DATABASE_URL`, `POSTGRES_PRISMA_URL` |
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| Admin / kiosco | `ADMIN_API_SECRET`, `KIOSK_ACCESS_CODE` |
| Mercado Pago legacy | `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`, `MERCADOPAGO_SANDBOX`, `MERCADOPAGO_BACK_URL_BASE`, `MERCADOPAGO_STATEMENT_DESCRIPTOR` |
| Mercado Pago Orders (congelado) | `MP_ORDERS_ACCESS_TOKEN`, `MP_ORDERS_WEBHOOK_SECRET`, `MP_ORDERS_BACK_URL_BASE`, `MP_ORDERS_QA_PAYER_EMAIL` |
| Correo | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` |
| Cron | `CRON_SECRET` |
| Entorno | `APP_ENV`, `VERCEL_ENV`, `NODE_ENV` |
| QA | `MP_PAYMENT_SIMULATION`, `MP_WEBHOOK_SUPPORT_CAPTURE` |
| Reservas | `COMMERCE_RESERVATION_TTL_MINUTES` |
| Payload | `PAYLOAD_SECRET` |
| WhatsApp | `NEXT_PUBLIC_WHATSAPP_SALES_PHONE`, `NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE`, `NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE`, `NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE` |
| Prefijos de integración | `BANGELH_*`, `UMANTAI_URL_*`, `UMANTAI_*` |

## 5. Diferencias relevantes de HEAD frente a Producción

Producción (`c402b97`/`4496551`) es anterior a todo el trabajo de la etapa
comercial. HEAD incluye, entre otros:

- Motor transaccional completo (`orders`, `order_items`, `inventory`,
  `inventory_movements`, `pickup_codes`, `order_status_*`) y migraciones
  **001–007**.
- Flujo de pago legacy de Mercado Pago: webhook, confirmación atómica,
  guardas de pago duplicado (005) y de conflicto de stock (006).
- Kiosco: PIN de 6 dígitos, intentos, cola, preparación y retiro.
- Simulación de pago QA y limpieza de pedidos QA (sólo Preview).
- Experimento aislado de Mercado Pago Orders (congelado).
- Observabilidad de webhooks y captura de soporte.
- Endurecimiento de admin/kiosco con secretos compartidos.
- Dependencias nuevas: `mercadopago`, `resend`.
- Cron diario en `vercel.json`.
- 270 tests unitarios y `scripts/audit-schema.ts`.

**No se puede asumir** que el esquema de Production coincida con el de
`.env.local` (QA/Preview), que tiene 001–003 y **no** tiene 004–007.

### 8.1 Confirmación de la auditoría read-only (2026-10-19)

La auditoría **sí se ejecutó** con el script `scripts/audit-schema.ts`
(`BEGIN READ ONLY`) usando la sesión autenticada de Vercel y las variables
`encrypted` legibles de la integración (las `sensitive` no se pueden leer).
Artefacto versionado: `audit-production.json`.

| Dato | Producción (ambas DBs candidatas) |
|---|---|
| Fingerprint | `sha256:78289625e1c5704217abe529568ee0ae43dab99c42dc1e9af0a3756e0549d5b4` |
| Tablas / funciones / triggers | **0 / 0 / 0** |
| Columnas / constraints / índices | **0 / 0 / 0** |
| Migraciones 001–007 | todas **FALTA** |
| Conteos | ninguno (no hay tablas) |

Por eso **no se generó un dump de Producción**: un `pg_dump` custom +
schema-only de una base sin objetos sólo produce un archivo vacío y no existe
una conexión productiva confirmada (la variable sensible no es legible). El
drill de backup/restore se hizo sobre la única base poblada: QA → `umantai_verify`
(ver `STAGING_RAILWAY.md` §3).

## 6. Bloqueo de Fase 3 (auditar DB de Production)

Para ejecutar `scripts/audit-schema.ts` contra Production hace falta **una** de
estas dos cosas:

1. `VERCEL_TOKEN` con acceso de lectura al proyecto (para `vercel env pull`
   en un directorio temporal), o
2. la connection string de Production entregada por un canal seguro
   (`AUDIT_DATABASE_URL` en el entorno, sin imprimirla).

Con eso se genera `audit-production.json` y se compara con `.env.local`.
**No se hizo ningún dump ni se escribió nada.**

## 7. Bloqueo de Fase 4/5 (Railway)

No hay Railway CLI instalado, no hay `RAILWAY_TOKEN` ni sesión guardada
(`~/.railway` no existe). Crear el proyecto/servicios requiere autenticación y,
según el plan, posiblemente tarjeta. **No se creó ningún recurso.**

Tampoco hay una DB de origen confirmada como productiva, así que **no se hizo
dump** (regla explícita de la Fase 5).

## 8. Producción verificada (2026-10-19, Vercel CLI autenticado)

| Dato | Valor |
|---|---|
| Proyecto Vercel | `umantai` (`prj_aor2ZwfDnr2JjlQ0iUBrj5L14J4q`) |
| Deployment ID | `dpl_9bdZFe4iUqiutjrfNziUHCw9qRi4` |
| Target | `production` · estado `Ready` |
| Creado | **2026-10-15 20:43:36 UTC** |
| Commit | **`c402b97`** (`ui(db-status): use amber inline '⚠️ Connection pooler detected' badge…`) |
| Rama | **`main`** |
| Repo / org | `Bangelh/umantai` |
| `gitDirty` | `1` (deploy manual desde un árbol con cambios sin commitear) |
| URL / aliases | `umantai-486zx62tz-umantai.vercel.app` · `umantai.com`, `www.umantai.com`, `umantai.vercel.app` |

### Variables presentes (solo nombres)

El pull de Production devolvió **70 variables**. Las relevantes para el runtime:

- DB: `POSTGRES_URL_NON_POOLING` (sensitive, production), `DATABASE_URL` (sensitive),
  `UMANTAI_URL_POSTGRES_URL*`, `UMANTAI_URL_DATABASE_URL`, `STORAGE_URL_POSTGRES_*`.
- Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (sensitive).
- Storage: `R2_*`, `STORAGE_URL_*`.
- Entorno/build: `VERCEL_*`, `TURBO_*`, `NX_DAEMON`.

**29 variables son `sensitive`**: Vercel no permite leer su valor por CLI ni por
API (`decrypt=true` devuelve vacío). `POSTGRES_URL_NON_POOLING` es una de ellas,
así que **no se puede demostrar criptográficamente** a qué host apunta el código
productivo. Sí se pudieron leer las variables `encrypted` de la misma integración:

| Alias legible (encrypted) | Host | Tablas en `public` |
|---|---|---|
| `UMANTAI_URL_POSTGRES_URL` (= `…_DATABASE_URL` = `…_PRISMA_DATABASE_URL`) | `db.prisma.io` / `postgres` | **0** |
| `STORAGE_URL_POSTGRES_URL_NON_POOLING` | `aws.neon.tech` / `neondb` | **0** |

Ambas bases se auditaron en `READ ONLY`: **0 tablas, 0 funciones, 0 triggers**,
fingerprint `sha256:78289625…`. Artefacto: `audit-production.json`.

### Evidencia funcional

- `GET https://umantai.com/api/categories` (vía `vercel curl`, autenticado) →
  `{"success":false,"error":"Error connecting to database: TypeError: fetch failed"}`.
- `GET /api/catalog/availability` → **404**: el deployment productivo es anterior a
  esa ruta. `/api/health` tampoco existe en Producción.
- Todo el dominio responde detrás de **Vercel Deployment Protection** (302 a SSO).

### Conclusión

Producción **no tiene el esquema comercial ni datos**: es un deployment viejo
(commit de junio) con una base vacía/inaccesible. No hay datos productivos que
copiar. La única base poblada es la de QA/Preview de `.env.local`
(fingerprint `sha256:bea7529f…`, 12 tablas, 14 pedidos), que se usó como **origen
verificado del restore de staging**. Ver `STAGING_RAILWAY.md`.
