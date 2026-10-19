#!/usr/bin/env node
/**
 * scripts/trigger-expire-reservations.mjs — cron portable (Railway).
 *
 * Llama al endpoint que YA existe (`/api/cron/expire-reservations`) con el
 * `CRON_SECRET`, igual que el cron de Vercel. No reimplementa la lógica: el
 * reaper sigue viviendo en Postgres.
 *
 * Variables:
 *   APP_BASE_URL     Base del servicio web (ej. http://web.railway.internal:3000).
 *                    Default: http://localhost:3000.
 *   CRON_SECRET      Obligatoria fuera de desarrollo.
 *   CRON_TIMEOUT_MS  Opcional, default 15000.
 *
 * Railway: crear un servicio cron con schedule `*\/15 * * * *` y start command
 *   `node scripts/trigger-expire-reservations.mjs`
 *
 * Sale con código ≠ 0 si el endpoint falla, para que Railway marque la ejecución
 * como fallida.
 */

const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const secret = (process.env.CRON_SECRET || '').trim();
const timeoutMs = Number(process.env.CRON_TIMEOUT_MS) || 15_000;

if (!secret) {
  console.error('[cron] CRON_SECRET no está configurado.');
  process.exit(1);
}

try {
  const response = await fetch(`${base}/api/cron/expire-reservations`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = await response.text();
  if (!response.ok) {
    console.error(`[cron] ${response.status} ${body.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`[cron] ok ${body.slice(0, 300)}`);
} catch (error) {
  console.error('[cron] fallo de red:', error instanceof Error ? error.message : error);
  process.exit(1);
}
