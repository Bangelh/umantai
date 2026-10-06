// Debe ir PRIMERO: fija la URL de base de datos antes de que `lib/env.ts` congele `envConfig`
// (la ruta del webhook exige base configurada antes de validar la firma).
import './helpers/preview-env';

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST } from '../app/api/payments/webhook/route';
import {
  MP_WEBHOOK_SUPPORT_CAPTURE_ENV,
  buildSupportManifest,
  buildWebhookSupportCapture,
  extractSignatureTimestamp,
  isAutomaticWebhookV1UserAgent,
  type WebhookSupportCaptureInput,
} from '../lib/payment-webhook-support-capture';

/**
 * Captura TEMPORAL de soporte de Mercado Pago (ticket WCS-53484).
 *
 * Garantías que fija esta suite:
 *   1. Production NUNCA captura, aunque el flag valga `1`.
 *   2. Preview con el flag ausente o distinto de `1` NUNCA captura.
 *   3. Preview + flag=1 + WebHook v1 AUTOMÁTICO inválido SÍ produce el objeto.
 *   4. Una firma VÁLIDA no entra a la captura.
 *   5. Una firma inválida sigue respondiendo HTTP 401 y no devuelve `x-signature`.
 *   6. `manifestExact` conserva literalmente `id:...;request-id:...;ts:...;`.
 *
 * No se usan secretos reales: el secreto y el hash son de juguete.
 */

const SECRET = 'unit-test-webhook-secret';
const MP_TOKEN = 'TEST-0000000000-aaaaaaaaaaaa-0000000000-aaaaaaaaaaaa';
const REQUEST_ID = '5e278faa-87ac-48e9-8ebd-567f2d341302';
const PAYMENT_ID = '182546703878';
const TS = '1764699137';

const AUTOMATIC_UA = 'MercadoPago WebHook v1.0 payment';
const SIMULATOR_UA = 'restclient-node/5.5.0';

function sign(manifest: string, secret: string = SECRET): string {
  return createHmac('sha256', secret).update(manifest).digest('hex');
}

function signatureHeader(ts: string, hash: string): string {
  return `ts=${ts},v1=${hash}`;
}

type Env = Record<string, string | undefined>;

async function withEnv<T>(env: Env, fn: () => Promise<T> | T): Promise<T> {
  const saved: Env = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function validCaptureInput(overrides: Partial<WebhookSupportCaptureInput> = {}): WebhookSupportCaptureInput {
  return {
    vercelEnv: 'preview',
    supportCaptureFlag: '1',
    receivedAt: '2026-10-06T12:00:00.000Z',
    dataIdQuery: PAYMENT_ID,
    xRequestId: REQUEST_ID,
    xSignature: signatureHeader(TS, sign(buildSupportManifest({ dataIdQuery: PAYMENT_ID, xRequestId: REQUEST_ID, ts: TS }))),
    userAgent: AUTOMATIC_UA,
    ...overrides,
  };
}

// =============================================================================
//  A. Gate de entorno: Production NUNCA captura, aunque el flag valga 1
// =============================================================================
test('A. Production nunca captura aunque el flag valga 1', () => {
  const captured = buildWebhookSupportCapture(validCaptureInput({ vercelEnv: 'production' }));
  assert.equal(captured, null);

  // Ni con `development` ni con `VERCEL_ENV` ausente hay captura: solo Preview.
  assert.equal(buildWebhookSupportCapture(validCaptureInput({ vercelEnv: 'development' })), null);
  assert.equal(buildWebhookSupportCapture(validCaptureInput({ vercelEnv: undefined })), null);
  assert.equal(buildWebhookSupportCapture(validCaptureInput({ vercelEnv: null })), null);
});

// =============================================================================
//  B. Gate del flag: Preview sin flag (o distinto de 1) no captura
// =============================================================================
test('B. Preview con flag ausente o distinto de 1 nunca captura', () => {
  assert.equal(buildWebhookSupportCapture(validCaptureInput({ supportCaptureFlag: undefined })), null);
  assert.equal(buildWebhookSupportCapture(validCaptureInput({ supportCaptureFlag: null })), null);
  assert.equal(buildWebhookSupportCapture(validCaptureInput({ supportCaptureFlag: '' })), null);
  assert.equal(buildWebhookSupportCapture(validCaptureInput({ supportCaptureFlag: '0' })), null);
  assert.equal(buildWebhookSupportCapture(validCaptureInput({ supportCaptureFlag: 'true' })), null);
});

// =============================================================================
//  C. Preview + flag=1 + automático v1 + valores presentes → objeto diagnóstico
// =============================================================================
test('C. Preview + flag=1 + WebHook v1 automático → produce el objeto diagnóstico', () => {
  const captured = buildWebhookSupportCapture(validCaptureInput());
  assert.notEqual(captured, null);
  if (!captured) return;

  assert.equal(captured.receivedAt, '2026-10-06T12:00:00.000Z');
  assert.equal(captured.dataIdQuery, PAYMENT_ID);
  assert.equal(captured.xRequestId, REQUEST_ID);
  assert.equal(captured.xSignature, validCaptureInput().xSignature);
  assert.equal(captured.ts, TS);
  assert.equal(captured.manifestExact, `id:${PAYMENT_ID};request-id:${REQUEST_ID};ts:${TS};`);
});

test('C2. el simulador (otro user-agent) NUNCA captura', () => {
  assert.equal(buildWebhookSupportCapture(validCaptureInput({ userAgent: SIMULATOR_UA })), null);
  assert.equal(isAutomaticWebhookV1UserAgent(SIMULATOR_UA), false);
  assert.equal(isAutomaticWebhookV1UserAgent(null), false);
});

test('C3. faltando cualquier valor obligatorio NUNCA captura', () => {
  assert.equal(buildWebhookSupportCapture(validCaptureInput({ dataIdQuery: null })), null);
  assert.equal(buildWebhookSupportCapture(validCaptureInput({ dataIdQuery: '   ' })), null);
  assert.equal(buildWebhookSupportCapture(validCaptureInput({ xRequestId: null })), null);
  assert.equal(buildWebhookSupportCapture(validCaptureInput({ xSignature: null })), null);
});

// =============================================================================
//  D. Formato LITERAL del manifest: id:...;request-id:...;ts:...;
// =============================================================================
test('D. manifestExact conserva literalmente data.id, x-request-id y ts', () => {
  const manifest = buildSupportManifest({
    dataIdQuery: '182546703878',
    xRequestId: '5e278faa-87ac-48e9-8ebd-567f2d341302',
    ts: '1764699137',
  });
  assert.equal(
    manifest,
    'id:182546703878;request-id:5e278faa-87ac-48e9-8ebd-567f2d341302;ts:1764699137;',
  );

  // Sin `ts` extraíble el hueco se conserva (nunca se omite el par).
  assert.equal(buildSupportManifest({ dataIdQuery: 'A', xRequestId: 'B', ts: null }), 'id:A;request-id:B;ts:;');
});

test('D2. `ts` se extrae de x-signature sin importar el orden', () => {
  assert.equal(extractSignatureTimestamp(`ts=${TS},v1=deadbeef`), TS);
  assert.equal(extractSignatureTimestamp(`v1=deadbeef, ts=${TS}`), TS);
  assert.equal(extractSignatureTimestamp('v1=deadbeef'), null);
  assert.equal(extractSignatureTimestamp('basura'), null);
  assert.equal(extractSignatureTimestamp(null), null);
});

// =============================================================================
//  E. RUTA real: firma inválida preserva 401 e imprime UNA línea de captura
// =============================================================================

interface LogCapture {
  infos: string[];
  errors: string[];
}

/** Captura lo que la ruta imprime y hace que ninguna red real ocurra. */
async function callWebhook(params: {
  env: Env;
  request: NextRequest;
}): Promise<{ status: number; json: Record<string, unknown>; logs: LogCapture }> {
  const logs: LogCapture = { infos: [], errors: [] };
  const originalInfo = console.info;
  const originalError = console.error;
  const originalFetch = globalThis.fetch;

  console.info = (...args: unknown[]) => {
    logs.infos.push(args.map((arg) => String(arg)).join(' '));
  };
  console.error = (...args: unknown[]) => {
    logs.errors.push(args.map((arg) => String(arg)).join(' '));
  };
  globalThis.fetch = (async () => {
    throw new Error('no network in tests');
  }) as typeof fetch;

  try {
    const response = await withEnv(params.env, () => POST(params.request));
    let json: Record<string, unknown> = {};
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: response.status, json, logs };
  } finally {
    console.info = originalInfo;
    console.error = originalError;
    globalThis.fetch = originalFetch;
  }
}

function webhookRequest(opts: {
  dataId: string;
  type?: string;
  xSignature: string;
  xRequestId?: string;
  userAgent?: string;
}): NextRequest {
  const url = new URL('https://preview.example.com/api/payments/webhook');
  url.searchParams.set('data.id', opts.dataId);
  if (opts.type !== undefined) url.searchParams.set('type', opts.type);
  const headers = new Headers();
  if (opts.xRequestId !== undefined) headers.set('x-request-id', opts.xRequestId);
  headers.set('x-signature', opts.xSignature);
  if (opts.userAgent !== undefined) headers.set('user-agent', opts.userAgent);
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: opts.type ?? 'payment', data: { id: opts.dataId } }),
  });
}

const PREVIEW_ENV: Env = {
  VERCEL_ENV: 'preview',
  [MP_WEBHOOK_SUPPORT_CAPTURE_ENV]: '1',
  MERCADOPAGO_ACCESS_TOKEN: MP_TOKEN,
  MERCADOPAGO_WEBHOOK_SECRET: SECRET,
};

function captureLines(logs: LogCapture): string[] {
  return logs.infos.filter((line) => line.includes('[mp-webhook][support-capture]'));
}

test('E. firma inválida automática en Preview + flag=1: 401 y UNA línea de captura', async () => {
  const forged = sign(`id:${PAYMENT_ID};request-id:${REQUEST_ID};ts:${TS};`, 'otro-secreto');
  const request = webhookRequest({
    dataId: PAYMENT_ID,
    type: 'payment',
    xSignature: signatureHeader(TS, forged),
    xRequestId: REQUEST_ID,
    userAgent: AUTOMATIC_UA,
  });

  const { status, json, logs } = await callWebhook({ env: PREVIEW_ENV, request });

  // La respuesta sigue siendo 401 y NO devuelve `x-signature`.
  assert.equal(status, 401);
  assert.equal(json.error, 'Invalid signature');
  assert.equal('x-signature' in json, false);
  assert.equal('xSignature' in json, false);

  const lines = captureLines(logs);
  assert.equal(lines.length, 1, 'debe imprimir EXACTAMENTE una línea');
  assert.equal(lines[0].includes('\n'), false, 'debe ser UNA sola línea');

  const payload = JSON.parse(lines[0].split('[mp-webhook][support-capture] ')[1]) as Record<string, unknown>;
  assert.equal(payload.dataIdQuery, PAYMENT_ID);
  assert.equal(payload.xRequestId, REQUEST_ID);
  assert.equal(payload.xSignature, signatureHeader(TS, forged));
  assert.equal(payload.ts, TS);
  assert.equal(payload.manifestExact, `id:${PAYMENT_ID};request-id:${REQUEST_ID};ts:${TS};`);
  assert.equal(typeof payload.receivedAt, 'string');

  // No se filtran secretos ni valores ajenos al pedido.
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(MP_TOKEN), false);
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['dataIdQuery', 'manifestExact', 'receivedAt', 'ts', 'xRequestId', 'xSignature'].sort(),
  );
});

// =============================================================================
//  F. RUTA real: firma VÁLIDA no entra a la captura
// =============================================================================
test('F. firma válida no entra a la captura (y no se rechaza)', async () => {
  const manifest = `id:${PAYMENT_ID};request-id:${REQUEST_ID};ts:${TS};`;
  const request = webhookRequest({
    dataId: PAYMENT_ID,
    type: 'merchant_order', // el tipo distinto de `payment` corta el flujo en 200
    xSignature: signatureHeader(TS, sign(manifest)),
    xRequestId: REQUEST_ID,
    userAgent: AUTOMATIC_UA,
  });

  const { status, logs } = await callWebhook({ env: PREVIEW_ENV, request });

  assert.equal(status, 200);
  assert.equal(captureLines(logs).length, 0, 'una firma válida no debe capturarse');
});

// =============================================================================
//  G. RUTA real: en Production NO se captura ni con flag=1
// =============================================================================
test('G. Production con flag=1 y firma inválida: 401 y cero capturas', async () => {
  const forged = sign(`id:${PAYMENT_ID};request-id:${REQUEST_ID};ts:${TS};`, 'otro-secreto');
  const request = webhookRequest({
    dataId: PAYMENT_ID,
    type: 'payment',
    xSignature: signatureHeader(TS, forged),
    xRequestId: REQUEST_ID,
    userAgent: AUTOMATIC_UA,
  });

  const { status, logs } = await callWebhook({
    env: { ...PREVIEW_ENV, VERCEL_ENV: 'production' },
    request,
  });

  assert.equal(status, 401);
  assert.equal(captureLines(logs).length, 0, 'Production no debe capturar aunque flag=1');
});
