#!/usr/bin/env node
/**
 * scripts/trigger-billing.mjs — cron portable de PLANES (Railway).
 *
 * Llama a `/api/cron/billing` con `CRON_SECRET`. Es un servicio SEPARADO del
 * cron de reservas de pedidos; no comparte lógica ni frecuencia.
 *
 * Variables:
 *   APP_BASE_URL     Base del servicio web (default http://localhost:3000).
 *   CRON_SECRET      Obligatoria fuera de desarrollo.
 *   CRON_TIMEOUT_MS  Opcional, default 15000.
 *
 * Railway: crear un segundo servicio cron con start command
 *   `node scripts/trigger-billing.mjs` y schedule `0 * * * *` (cada hora).
 */

const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const secret = (process.env.CRON_SECRET || '').trim();
const timeoutMs = Number(process.env.CRON_TIMEOUT_MS) || 15_000;

if (!secret) {
  console.error('[billing-cron] CRON_SECRET no está configurado.');
  process.exit(1);
}

try {
  const response = await fetch(`${base}/api/cron/billing`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (!response.ok) {
    console.error(`[billing-cron] ${response.status} ${body.slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`[billing-cron] ok ${body.slice(0, 500)}`);
} catch (error) {
  console.error('[billing-cron] fallo de red:', error instanceof Error ? error.message : error);
  process.exit(1);
}
