#!/usr/bin/env node
/**
 * scripts/trigger-expire-reservations.mjs — disparo manual del cron de pedidos.
 *
 * Llama al endpoint que YA existe (`/api/cron/expire-reservations`) con el
 * `CRON_SECRET`, igual que el cron de Vercel. No reimplementa la lógica: el
 * reaper sigue viviendo en Postgres. En staging el servicio Railway existente
 * usa `scripts/run-cron.mjs`, que ejecuta este job y el de planes.
 *
 * Variables:
 *   APP_BASE_URL     Base del servicio web (ej. http://web.railway.internal:3000).
 *                    Default: http://localhost:3000.
 *   CRON_SECRET      Obligatoria fuera de desarrollo.
 *   CRON_TIMEOUT_MS  Opcional, default 15000.
 *
 * Sale con código ≠ 0 si el endpoint falla, para que Railway marque la ejecución
 * como fallida.
 */

import { resolveCronConfig, runCronJobs } from './lib/cron-client.mjs';

const config = resolveCronConfig();
const { ok } = await runCronJobs(
  [{ name: 'expire-reservations', path: '/api/cron/expire-reservations' }],
  { config },
);

process.exit(ok ? 0 : 1);
