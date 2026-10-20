/**
 * tests/cron-runner.test.ts — cron combinado (reservas + billing).
 *
 * Verifica el contrato operativo, no la lógica de negocio:
 *   · ambos jobs se disparan con CRON_SECRET;
 *   · si uno falla, el otro igual se ejecuta;
 *   · un fallo parcial de billing (200 con `ok:false`) también marca la corrida;
 *   · el exit code refleja el fallo real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'cron-test-secret';

type RouteReply = { status: number; body: string };

/**
 * Servidor local que imita los dos endpoints. Registra cada request y exige el
 * Bearer correcto para que el test también cubra el header.
 */
async function startCronServer(replies: {
  reservations: RouteReply;
  billing: RouteReply;
}) {
  const calls: Array<{ path: string; authorization: string | undefined }> = [];

  const server = http.createServer((request, response) => {
    const path = request.url ?? '';
    calls.push({ path, authorization: request.headers.authorization });

    if (request.headers.authorization !== `Bearer ${SECRET}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }

    const reply = path.startsWith('/api/cron/expire-reservations')
      ? replies.reservations
      : path.startsWith('/api/cron/billing')
        ? replies.billing
        : { status: 404, body: '{}' };

    response.writeHead(reply.status, { 'content-type': 'application/json' });
    response.end(reply.body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'el servidor de prueba debe tener puerto');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function runCli(env: Record<string, string | undefined>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['scripts/run-cron.mjs'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('ambos jobs OK: se ejecutan en orden con CRON_SECRET y exit 0', async () => {
  const server = await startCronServer({
    reservations: { status: 200, body: JSON.stringify({ ok: true, expiredOrders: 2 }) },
    billing: { status: 200, body: JSON.stringify({ ok: true, renewed: 1, failed: 0 }) },
  });

  try {
    const result = await runCli({
      APP_BASE_URL: server.baseUrl,
      CRON_SECRET: SECRET,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      server.calls.map((call) => call.path),
      ['/api/cron/expire-reservations', '/api/cron/billing'],
    );
    assert.ok(server.calls.every((call) => call.authorization === `Bearer ${SECRET}`));
    assert.match(result.stdout, /"ok": true/);
  } finally {
    await server.close();
  }
});

test('si reservas falla, billing igual corre y el exit refleja el fallo', async () => {
  const server = await startCronServer({
    reservations: { status: 500, body: JSON.stringify({ error: 'reaper caído' }) },
    billing: { status: 200, body: JSON.stringify({ ok: true, renewed: 0 }) },
  });

  try {
    const result = await runCli({
      APP_BASE_URL: server.baseUrl,
      CRON_SECRET: SECRET,
    });

    assert.equal(result.code, 1);
    assert.deepEqual(
      server.calls.map((call) => call.path),
      ['/api/cron/expire-reservations', '/api/cron/billing'],
    );
    assert.match(result.stderr, /expire-reservations FAILED http_500/);
    assert.match(result.stderr, /reaper caído/);
    assert.match(result.stdout, /"ok": false/);
  } finally {
    await server.close();
  }
});

test('fallo parcial de billing (200 con ok:false) también marca la corrida', async () => {
  const server = await startCronServer({
    reservations: { status: 200, body: JSON.stringify({ ok: true, expiredOrders: 0 }) },
    billing: {
      status: 200,
      body: JSON.stringify({ ok: false, renewed: 0, failed: 1, errors: ['store_x'] }),
    },
  });

  try {
    const result = await runCli({
      APP_BASE_URL: server.baseUrl,
      CRON_SECRET: SECRET,
    });

    assert.equal(result.code, 1);
    assert.equal(server.calls.length, 2);
    assert.match(result.stderr, /billing FAILED job_reported_failure/);
  } finally {
    await server.close();
  }
});

test('sin CRON_SECRET no se dispara ningún job y el exit es 1', async () => {
  const server = await startCronServer({
    reservations: { status: 200, body: '{"ok":true}' },
    billing: { status: 200, body: '{"ok":true}' },
  });

  try {
    const result = await runCli({
      APP_BASE_URL: server.baseUrl,
      CRON_SECRET: '',
    });

    assert.equal(result.code, 1);
    assert.equal(server.calls.length, 0);
    assert.match(result.stderr, /CRON_SECRET no está configurado/);
  } finally {
    await server.close();
  }
});
