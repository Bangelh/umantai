# Migraciones 004–007 — análisis y fingerprint antes/después

**Fecha:** 2026-10-19
**Método:** PostgreSQL 17 efímero en `localhost` (`embedded-postgres`), migraciones
aplicadas **una por una**, fingerprint READ ONLY después de cada archivo con
`scripts/audit-schema.ts` (`BEGIN READ ONLY`).
**Artefacto reproducible:** `migrations-004-007-fingerprints.json`
**Comando:** `npm run migrations:drill`

> **NO se aplicó nada en Producción, Preview, QA ni Railway.**
> Este drill usa un cluster temporal que se borra al terminar. No lee ninguna
> connection string externa ni contiene datos de negocio.

---

## 1. Resultado medido

| Paso | Fingerprint (sha256) | Tablas | Columnas | Funciones | Triggers | Índices | Constraints | Migraciones faltantes |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 001_commerce_core | `f595ee06…` | 8 | 119 | 12 | 8 | 33 | 46 | 002–007 |
| 002_payment_confirmation | `3fb92a99…` | 8 | 119 | 14 | 8 | 33 | 46 | 003–007 |
| **003_pickup_pin_kiosk (baseline)** | **`2b6d872f987d9a50…`** | **9** | **125** | **16** | **8** | **36** | **47** | **004–007** |
| 004_payment_webhook_diagnostics | `738948fc…` | 10 | 150 | 16 | 8 | 39 | 48 | 005–007 |
| 005_duplicate_payment_guard | `2067d897…` | 10 | 150 | 16 | 8 | 39 | 48 | 006–007 |
| 006_fulfillment_stock_conflict_guard | `2ea20fac…` | 10 | 150 | 16 | 8 | 39 | 48 | 007 |
| **007_release_respects_rereservation** | **`b1e83982…`** | **10** | **150** | **16** | **8** | **39** | **48** | **ninguna** |

Los hashes completos están en el JSON. El fingerprint cubre tablas, columnas,
constraints, índices, funciones (con hash del cuerpo), triggers y la presencia de
cada migración; **no** incluye conteos de filas.

## 2. Qué cambia cada migración

### 004 — `payment_webhook_diagnostics`
- Añade la tabla `payment_webhook_events` (+25 columnas, +3 índices, +1 constraint).
- Es la única de las cuatro que cambia el **esquema físico**; 005–007 sólo
  reemplazan cuerpos de funciones.
- Verificado: el chequeo `004_payment_webhook_diagnostics` pasa de `FALTA` a `OK`.

### 005 — `duplicate_payment_guard`
- Reemplaza `confirm_order_payment(...)`.
- Marcador medido: aparece `duplicatePayment` en el cuerpo de la función.
- Efecto funcional: un segundo pago distinto marca `duplicatePayment`/`needsReview`
  y **no** sobrescribe la referencia del primero.

### 006 — `fulfillment_stock_conflict_guard`
- Reemplaza `mark_order_ready_for_pickup`, `inventory_commit_order` y
  `redeem_pickup_code_verified`.
- Marcador medido: `order_requires_review` en los tres cuerpos.
- Efecto funcional: un pedido con conflicto de stock o pago duplicado no puede
  prepararse, entregarse ni retirarse por la vía normal.

### 007 — `release_respects_rereservation`
- Reemplaza `inventory_release_order`.
- Marcador medido: aparece el predicado `prior_releases`.
- Efecto funcional: liberar un pedido no devuelve al stock disponible líneas que
  ya fueron re-reservadas por un pago tardío.

## 3. Verificación funcional posterior

Después de aplicar 001–007 en orden, la suite de integración
(`npm run test:integration`) ejecuta **8/8** escenarios contra el mismo
PostgreSQL 17 real: creación/reserva, idempotencia, cancelación/liberación, pago
simulado, reintento idempotente, pago duplicado, PIN/retiro/commit de stock y PIN
inválido.

## 4. Comparación con la base inspeccionada en `.env.local`

El fingerprint del paso 003 es reproducible (`2b6d872f…`), pero **no** es
directamente comparable con el fingerprint completo de la base de `.env.local`:
esa base también contiene las tablas de Payload (`categories`, `brands`,
`product_overrides`, etc.), que no forman parte de `db/migrations/001–003`.
La comparación válida contra Producción/staging se hará con el mismo comando
(`scripts/audit-schema.ts`) sobre ambas bases completas.

## 5. Estado

- [x] 004–007 analizadas y aplicadas en un PostgreSQL 17 efímero.
- [x] Fingerprint antes/después por migración.
- [x] Integración funcional 8/8 después de 007.
- [x] **Aplicadas en Railway staging (PostgreSQL 17.11)** una por una, con
  `ON_ERROR_STOP` y verificación de marcadores. Fingerprint post-migraciones:
  `sha256:45b59079…`; integración 8/8 contra `umantai_integration`.
- [ ] Producción: fuera de alcance; requiere cutover autorizado (y hoy no tiene
  esquema comercial).

Detalle del entorno: `STAGING_RAILWAY.md`.
