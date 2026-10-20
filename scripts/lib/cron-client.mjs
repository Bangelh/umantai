/**
 * scripts/lib/cron-client.mjs — invocación HTTP compartida de los crons.
 *
 * Un solo lugar construye el request, aplica `CRON_SECRET`, interpreta la
 * respuesta y aísla el fallo de cada job. La lógica de negocio sigue viviendo
 * en los endpoints (`/api/cron/...`); acá solo se dispara y se reporta.
 */

/** Configuración común. Nunca imprime el secreto. */
export function resolveCronConfig(env = process.env) {
  return {
    base: (env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    secret: (env.CRON_SECRET || '').trim(),
    timeoutMs: Number(env.CRON_TIMEOUT_MS) || 15_000,
  };
}

/**
 * Dispara un job y devuelve SIEMPRE un resultado (nunca lanza).
 *
 * Un 2xx con `{ ok: false }` también cuenta como fallo: el endpoint de billing
 * responde 200 con fallos parciales, y el cron debe reflejarlo en el exit code.
 */
export async function callCronEndpoint(job, config, fetchImpl = fetch) {
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(`${config.base}${job.path}`, {
      headers: { Authorization: `Bearer ${config.secret}` },
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    const text = await response.text();
    const body = text.slice(0, 500);
    let ok = response.ok;
    let reason = response.ok ? null : `http_${response.status}`;

    if (ok) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.ok === false) {
          ok = false;
          reason = 'job_reported_failure';
        }
      } catch {
        // Cuerpo no JSON: manda el status HTTP.
      }
    }

    return {
      name: job.name,
      path: job.path,
      ok,
      status: response.status,
      reason,
      body,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      name: job.name,
      path: job.path,
      ok: false,
      status: null,
      reason: 'network_error',
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Ejecuta los jobs en orden. Si uno falla, se registra y se continúa con el
 * siguiente; el resultado global es `ok` solo si todos pasaron.
 */
export async function runCronJobs(jobs, options = {}) {
  const config = options.config ?? resolveCronConfig(options.env ?? process.env);

  if (!config.secret) {
    console.error('[cron] CRON_SECRET no está configurado: no se dispara ningún job.');
    return { ok: false, reason: 'cron_secret_missing', results: [] };
  }

  const results = [];

  for (const job of jobs) {
    const result = await callCronEndpoint(job, config, options.fetchImpl);
    results.push(result);

    if (result.ok) {
      console.info(`[cron] ${job.name} ok (${result.durationMs} ms) ${result.body ?? ''}`.trim());
    } else {
      const detail = result.body ?? result.error ?? '';
      console.error(`[cron] ${job.name} FAILED ${result.reason} (${result.durationMs} ms) ${detail}`.trim());
    }
  }

  return { ok: results.every((result) => result.ok), results };
}
