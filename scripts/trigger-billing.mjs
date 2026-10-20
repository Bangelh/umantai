#!/usr/bin/env node
/**
 * scripts/trigger-billing.mjs — disparo manual del cron de PLANES.
 *
 * Llama a `/api/cron/billing` con `CRON_SECRET`. En staging el servicio Railway
 * existente usa `scripts/run-cron.mjs`, que ejecuta billing junto con la
 * expiración de reservas; este script queda para disparos puntuales.
 *
 * Variables:
 *   APP_BASE_URL     Base del servicio web (default http://localhost:3000).
 *   CRON_SECRET      Obligatoria fuera de desarrollo.
 *   CRON_TIMEOUT_MS  Opcional, default 15000.
 */

import { resolveCronConfig, runCronJobs } from './lib/cron-client.mjs';

const config = resolveCronConfig();
const { ok } = await runCronJobs([{ name: 'billing', path: '/api/cron/billing' }], { config });

process.exit(ok ? 0 : 1);
