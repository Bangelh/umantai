# INFRASTRUCTURE FOUNDATION — PASS

**Fecha:** 2026-10-19
**Rama:** `feat/railway-staging`
**Alcance:** staging Railway/PostgreSQL 17 + verificación read-only de Producción.
Nada de Producción fue modificado; Mercado Pago sigue congelado.

---

## 1. HEAD desplegado y entorno

| Dato | Valor |
|---|---|
| HEAD desplegado | `d5042b4ec6263f09239de6749b3f7be54a2ed6e7` |
| Verificación | `/api/health` → `commit: "d5042b4…"`. El deploy por archivo no expone SHA: se inyecta `GIT_COMMIT_SHA` antes de `railway up` y el árbol estaba limpio (sólo artefactos no trackeados), por lo que lo subido coincide con el árbol de HEAD |
| URL staging | https://web-staging-6756.up.railway.app |
| Base staging | Railway `Postgres17` 17.11, DB `railway` |
| `APP_ENV` | `staging` |
| Producción | **no tocada** |

El pedido original citaba `8393914`; sobre ese HEAD se agregó el fix de Supabase
(§6), por lo que el commit de runtime desplegado y verificado es su sucesor
`d5042b4`. Los commits posteriores (`docs(infra)`) sólo agregan Markdown y
JSON de evidencia: `git diff d5042b4 HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs'
package.json` está **vacío**, así que el código desplegado coincide exactamente
con el árbol de código de HEAD.

## 2. Producción — baseline y auditoría REAL

La auditoría **se ejecutó** el 2026-10-19 con `scripts/audit-schema.ts` en
`BEGIN READ ONLY`, usando la sesión autenticada de Vercel y las variables
`encrypted` legibles de la integración de Supabase/Postgres. Las variables
`sensitive` (`POSTGRES_URL_NON_POOLING`) no son legibles por API/CLI, por lo que
se auditaron **las dos** DBs candidatas de la integración.

| Dato | Producción |
|---|---|
| Artefacto | `audit-production.json` |
| Fingerprint | `sha256:78289625e1c5704217abe529568ee0ae43dab99c42dc1e9af0a3756e0549d5b4` |
| Tablas | **0** |
| Columnas / constraints / índices | **0 / 0 / 0** |
| Funciones / triggers | **0 / 0** |
| Conteos | ninguno (no hay tablas) |
| 001–007 | todas **FALTA** |
| Server | PostgreSQL 17.2 |
| Deployment Vercel | `dpl_9bdZFe4iUqiutjrfNziUHCw9qRi4`, commit `c402b97` (junio), target production |

### Diferencias contra `.env.local` (QA/Preview)

| Dato | Producción | `.env.local` (QA) |
|---|---|---|
| Fingerprint | `78289625…` | `bea7529f…` |
| Tablas / columnas | 0 / 0 | 12 / 140 |
| Funciones / triggers | 0 / 0 | 16 / 8 |
| Índices / constraints | 0 / 0 | 43 / 52 |
| 001–003 | FALTA | OK |
| 004–007 | FALTA | FALTA |
| `orders` / `inventory_movements` | 0 / 0 | 14 / 74 |
| Server | PG 17.2 | PG 17.11 |

### Diferencias contra Railway staging

| Dato | Producción | Staging `railway` |
|---|---|---|
| Fingerprint | `78289625…` | `45b59079…` |
| Tablas / columnas | 0 / 0 | 13 / 165 |
| Funciones / triggers | 0 / 0 | 16 / 8 |
| Índices / constraints | 0 / 0 | 46 / 53 |
| 001–007 | FALTA | **OK (7/7)** |
| `orders` | 0 | 15 (14 del restore + 1 smoke) |

**Conclusión:** Producción no tiene el esquema comercial ni datos; no hay nada
que copiar ni un dump productivo que hacer. El dump de Producción se marca
**N/A justificado** (un dump de una base sin objetos es vacío).

## 3. Fingerprints del entorno

| Base | Momento | Fingerprint | Tablas | Funciones | Triggers | Índices | Constraints |
|---|---|---|---:|---:|---:|---:|---:|
| Producción | auditada | `78289625…` | 0 | 0 | 0 | 0 | 0 |
| QA `.env.local` | origen | `bea7529f…` | 12 | 16 | 8 | 43 | 52 |
| `umantai_verify` | restore del backup | `bea7529f…` | 12 | 16 | 8 | 43 | 52 |
| Staging `railway` | pre-004–007 | `bea7529f…` | 12 | 16 | 8 | 43 | 52 |
| Staging `railway` | post-004–007 | `45b59079…` | 13 | 16 | 8 | 46 | 53 |
| `umantai_drill_20261019` | clon real + tests | `45b59079…` | 13 | 16 | 8 | 46 | 53 |

Artefactos: `audit-production.json`, `audit-qa.json`,
`audit-staging-pre-migrations.json`, `audit-staging.json`,
`audit-umantai_verify-current.json`, `audit-railway-current.json`,
`audit-drill-clone.json`.

## 4. Backup y restore drill

### Artefactos

| Archivo | Bytes | SHA-256 |
|---|---:|---|
| `backups/qa.dump` (custom, con datos) | 106.518 | `b26d101a5c8da6704dda98c7d0a6be8f6909a06ea9662ce77f66096a3e5dd1d7` |
| `backups/qa-schema.dump` (schema-only) | 86.951 | `f9c98b3b1d0e723ef83df8fd80e0d48a85589245d8cfc31c8d8d7ee80e9de3fe` |

`backups/` está gitignored (contiene datos). El dump se generó contra la única
base poblada (QA), no contra Producción.

### Drill ejecutado

1. Restore en `umantai_verify` (Railway PG17) con `pg_restore --exit-on-error`.
2. Fingerprint idéntico al origen: `bea7529f…`; 12 tablas, 16 funciones,
   8 triggers, 43 índices, 52 constraints.
3. Conteos idénticos: 14 `orders`, 14 `order_items`, 49 `inventory`,
   74 `inventory_movements`, 22 `order_status_history`, 19
   `order_status_transitions`, 5 `pickup_attempts`, 4 `pickup_codes`.
4. Secuencias idénticas al origen: `order_number_seq=1016`,
   `inventory_movements_id_seq=74`, `order_status_history_id_seq=22`,
   `pickup_attempts_id_seq=5`.
5. Drill fresco adicional: clon `umantai_drill_20261019` creado con
   `pg_dump | pg_restore` dentro del contenedor PG17 (sin sacar credenciales):
   15 pedidos, 49 inventario; suites 8/8; fingerprint `45b59079…` sin cambios
   después de los tests.

**Restore drill: PASS.**

## 5. Migraciones 004–007 sobre una copia real

Se aplicaron **una por una** en staging (copia real de QA), con
`psql -v ON_ERROR_STOP=1`, verificando marcadores después de cada archivo:

| Migración | Verificación | Resultado |
|---|---|---|
| 004 `payment_webhook_diagnostics` | `payment_webhook_events` existe | PASS |
| 005 `duplicate_payment_guard` | `duplicatePayment` en `confirm_order_payment` | PASS |
| 006 `fulfillment_stock_conflict_guard` | `order_requires_review` en `mark_order_ready_for_pickup`, `inventory_commit_order`, `redeem_pickup_code_verified` (3/3) | PASS |
| 007 `release_respects_rereservation` | `prior_releases` en `inventory_release_order` | PASS |

Verificación directa de cuerpos en `pg_proc` (2026-10-19):

```
confirm_order_payment            dup=t review=f prior=f
inventory_commit_order           dup=f review=t prior=f
mark_order_ready_for_pickup      dup=f review=t prior=f
redeem_pickup_code_verified      dup=f review=t prior=f
inventory_release_order          dup=f review=f prior=t
```

Fingerprint antes `bea7529f…` → después `45b59079…` (+1 tabla, +25 columnas,
+3 índices, +1 constraint; funciones/triggers sin cambios de conteo).

### Escenarios funcionales

`npm run test:integration` contra el clon real `umantai_drill_20261019`:
**8/8 PASS** (creación/reserva, idempotencia, cancelación/liberación, pago
aprobado, reintento idempotente, pago duplicado, PIN/retiro/commit de stock,
PIN inválido). Conteos de negocio del clon: 23 pedidos, 57 inventario,
97 movimientos (los tests agregan datos al clon, no a staging).

**004–007 en copia real: PASS.** Producción no se tocó.

## 6. Supabase — build y degradación

**Causa raíz:** `lib/supabase/server.ts` construía el cliente a nivel de import;
`createClient()` de Supabase lanza `Invalid supabaseUrl` si la URL es un
placeholder. `next build` recolecta `/api/notes`, importa el módulo y fallaba
aunque Notes sea opcional.

**Solución (mínima, sin valores falsos):**

- Nuevo `lib/supabase/config.ts`: valida URL http(s) parseable y key no vacía.
- `lib/supabase/server.ts` / `client.ts`: el cliente queda `null` si no hay
  configuración válida (no se construye con basura).
- `utils/supabase/env.ts`: un placeholder inválido se reporta como no
  configurado; `utils/supabase/{server,client}.ts` fallan con mensaje claro sólo
  al **usarse**, no al importarse.
- Las rutas ya existentes degradan: `/api/notes` → **503** “Supabase is not
  configured”; la lista de compras mantiene su comportamiento local-only.

**Verificación:**

| Escenario | Resultado |
|---|---|
| `npm run build` con `.env.local` (placeholder inválido) | PASS |
| `npm run build` sin `.env.local` ni variables Supabase | PASS |
| `/api/notes` con token admin en staging | 503 (no 500) |
| Autenticación Multi-Tienda | sin cambios |

No se agregaron credenciales falsas ni reales de Supabase.

## 7. PostgreSQL 18 sin uso

| Pregunta | Respuesta |
|---|---|
| Para qué se creó | Template por defecto de Railway (`--database postgres`) al crear el proyecto; quedó como servicio `Postgres`. |
| Tiene datos | **Sí**: DB `railway` con 21 tablas (copia de QA: 14 pedidos, 49 inventario, 74 movimientos, tablas Payload/auth) y DB `umantai_restore_drill` (misma copia). |
| Algún servicio lo referencia | **No**. `web` y `cron` apuntan a `Postgres17`; el propio `Postgres` es el único que contiene su dominio. |
| Genera costo | **Sí**: volumen persistente (74 MB usados de 434 MB) + contenedor online. El monto exacto está en Usage del workspace. |
| Es seguro eliminarlo | Técnicamente sí (sin referencias y con copia equivalente en PG17/QA), pero **no se elimina**: contiene evidencia de restore y la ventana de convivencia es de 30 días. |

**Acción: ninguna** (sólo informe).

## 8. Smoke staging (post-deploy `d5042b4`)

| Check | Resultado |
|---|---|
| `/api/health` | 200, `ok:true`, `environment:staging`, DB `pg` reachable, commit correcto |
| `/api/categories` | 200 |
| `/api/catalog/availability?slug=test` | 200 |
| Cron sin token | 401 |
| Cron con token | 200 `{"ok":true,"expiredOrders":0}` |
| Servicio cron | ejecución real `EXITED` 6 s, `[cron] ok` |
| `/api/notes` con admin | 503 esperado (Supabase no configurado) |

## 9. CI / checks locales

| Check | Resultado |
|---|---|
| `tsc --noEmit` | PASS (0 errores) |
| Unit tests | PASS (287/287) |
| Integration tests (efímero) | PASS (8/8) |
| Integration tests (clon staging) | PASS (8/8) |
| Lint incremental (27 archivos vs `e4d39ad`) | PASS (0 errores, 1 warning preexistente en `next.config.ts`) |
| Build sin Supabase | PASS |
| GitHub Actions | **no ejecutado en esta sesión** (no hay `gh`); se replicaron los pasos del workflow localmente |

## 10. Commits de la fase

| Commit | Contenido |
|---|---|
| `6841991` | `fix(env)`: Producción por `APP_ENV` + integración contra DB externa |
| `2f3a2d7` | `feat(scripts)`: `pg_dump` portable + auditorías |
| `97e55fe` | `docs(infra)`: baseline real de Producción y staging |
| `60e4606` | `docs(staging)`: cron corregido y pre-flight |
| `8393914` | `fix(env)`: tipos sin `any` |
| `d5042b4` | `fix(supabase)`: degradación sin configuración y build sin placeholders |
| `docs(infra)` | runbook de rollback + este informe + evidencia de auditorías (commit de cierre) |

## 11. Riesgos restantes

1. **Producción sigue en un deployment viejo de junio, sin esquema comercial.**
   El cutover es una tarea aparte y requiere autorización explícita.
2. **Mercado Pago congelado/no configurado**: checkout 503; no se puede validar
   pago real ni webhooks firmados en staging.
3. **Supabase no configurado en staging**: Notes/Shopping List inactivas (por
   diseño hasta decidir si son obligatorias).
4. **PG18 duplicado**: consume volumen/cómputo; no borrar antes de 30 días.
5. **Backups manuales**: no hay schedule automático a R2/S3; el runbook exige
   verificarlos antes de un cutover.
6. **URL productiva no demostrable**: `POSTGRES_URL_NON_POOLING` es `sensitive`;
   ambas DBs candidatas están vacías.
7. **Datos de smoke en staging**: 1 pedido (`UM-2026-001017`) y 1 evento de
   webhook de prueba; no afectan esquema ni tests.
8. **`umantai_integration` quedó sucio** de corridas previas (inventario
   duplicado): la suite 5/8 falló ahí por datos acumulados, no por esquema. La
   corrida válida se hizo sobre un clon limpio de la base staging: **8/8**.
   Limpiar/rotar esa DB de test antes de reutilizarla.

## 12. Veredicto

# READY FOR FEATURE DEVELOPMENT

La base de infraestructura de staging está verificada de punta a punta: deploy
exacto, esquema 001–007, backup/restore con fingerprint y secuencias, migraciones
probadas sobre copia real, build independiente de Supabase y runbook de rollback.
Producción permanece intacta y su cutover queda como fase separada.
