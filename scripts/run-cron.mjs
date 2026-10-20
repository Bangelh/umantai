#!/usr/bin/env node
/**
 * scripts/run-cron.mjs — cron único del servicio Railway existente.
 *
 * Ejecuta, de forma independiente y en este orden:
 *   1. expiración de reservas de pedidos (`/api/cron/expire-reservations`);
 *   2. ciclo de PLANES (`/api/cron/billing`): renovaciones, cancelaciones,
 *      expiraciones y gracia de `past_due`.
 *
 * - Ambos endpoints siguen protegidos por `CRON_SECRET`; este script solo lo
 *   reenvía. La lógica de negocio NO se duplica: vive en cada endpoint.
 * - Si un job falla, se registra y el otro se ejecuta igual.
 * - Sale con código ≠ 0 si cualquiera falló (incluye fallos parciales de
 *   billing, que responden 200 con `{ ok: false }`), para que Railway marque la
 *   corrida como fallida.
 * - Billing conserva su idempotencia (`FOR UPDATE`, período + idempotency_key);
 *   ejecutarlo cada 15 minutos es seguro.
 *
 * Variables:
 *   APP_BASE_URL     Base del servicio web (default http://localhost:3000).
 *   CRON_SECRET      Obligatoria fuera de desarrollo.
 *   CRON_TIMEOUT_MS  Timeout por job, default 15000.
 */

import { resolveCronConfig, runCronJobs } from './lib/cron-client.mjs';

const JOBS = [
  { name: 'expire-reservations', path: '/api/cron/expire-reservations' },
  { name: 'billing', path: '/api/cron/billing' },
];

const config = resolveCronConfig();

if (!config.secret) {
  console.error('[cron] CRON_SECRET no está configurado: no se dispara ningún job.');
  process.exit(1);
}

const { ok, results } = await runCronJobs(JOBS, { config });

console.info(
  JSON.stringify(
    {
      ok,
      base: config.base,
      results: results.map(({ name, path, ok: jobOk, status, reason, durationMs }) => ({
        name,
        path,
        ok: jobOk,
        status,
        reason,
        durationMs,
      })),
    },
    null,
    2,
  ),
);

process.exit(ok ? 0 : 1);
