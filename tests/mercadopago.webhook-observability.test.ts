import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { verifyMercadoPagoWebhookSignature } from '../lib/mercadopago.server';
import { recordPaymentWebhookEvent } from '../lib/commerce.server';
import {
  buildWebhookEventRecord,
  summarizeSignatureHeader,
  webhookOutcome,
  type WebhookObservabilityInput,
} from '../lib/payment-webhook-observability';

/**
 * Instrumentación del webhook de Mercado Pago.
 *
 * Estos tests fijan la garantía central: la observabilidad NUNCA cambia el
 * resultado del webhook (firma inválida sigue siendo 401) y NUNCA persiste un
 * secreto ni un valor completo de firma / request-id. Se prueban las piezas puras
 * más la escritura best-effort, sin red ni base de datos.
 */

const SECRET = 'unit-test-webhook-secret';
const REQUEST_ID = '5e278faa-87ac-48e9-8ebd-567f2d341302';
const PAYMENT_ID = '182145601434';
const TS = '1764699137';

/** Hash real de 64 hex: sirve para comprobar que NO se filtra a la persistencia. */
function sign(manifest: string, secret: string = SECRET): string {
  return createHmac('sha256', secret).update(manifest).digest('hex');
}

function withSecret<T>(secret: string | null, fn: () => T): T {
  const previous = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (secret === null) delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
  else process.env.MERCADOPAGO_WEBHOOK_SECRET = secret;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
    else process.env.MERCADOPAGO_WEBHOOK_SECRET = previous;
  }
}

const HASH = sign(`id:${PAYMENT_ID};request-id:${REQUEST_ID};ts:${TS};`);

function sampleInput(overrides: Partial<WebhookObservabilityInput> = {}): WebhookObservabilityInput {
  return {
    pathname: '/api/payments/webhook',
    queryParamNames: ['data.id', 'type'],
    queryDataId: PAYMENT_ID,
    bodyDataId: PAYMENT_ID,
    dataId: PAYMENT_ID,
    queryType: 'payment',
    bodyType: 'payment',
    action: 'payment.created',
    liveMode: true,
    userId: '3228895377',
    xRequestId: REQUEST_ID,
    xSignature: `ts=${TS},v1=${HASH}`,
    userAgent: 'MercadoPago/1.0',
    xRetry: '1',
    ...overrides,
  };
}

// =============================================================================
//  C. No se persisten secretos ni firmas / request-id completos
// =============================================================================
test('C. el registro NO contiene secret, hash v1 completo ni request-id completo', () => {
  const record = buildWebhookEventRecord(sampleInput());
  const serialized = JSON.stringify(record);

  assert.equal(serialized.includes(HASH), false, 'el hash v1 no debe aparecer');
  assert.equal(serialized.includes(REQUEST_ID), false, 'el x-request-id no debe aparecer');
  assert.equal(serialized.includes(SECRET), false, 'el secreto no debe aparecer');
  assert.equal(serialized.includes(`ts=${TS},v1=${HASH}`), false, 'x-signature completo no debe aparecer');

  // En su lugar quedan PRESENCIA y LONGITUD.
  assert.equal(record.xSignaturePresent, true);
  assert.equal(record.signatureHasTs, true);
  assert.equal(record.signatureHasV1, true);
  assert.equal(record.tsLength, TS.length);
  assert.equal(record.v1Length, HASH.length);
  assert.equal(record.xRequestIdPresent, true);
  assert.equal(record.xRequestIdLength, REQUEST_ID.length);
});

// =============================================================================
//  D. Query vs body: se captura si `data.id` coincide
// =============================================================================
test('D. captura coincidencia/mismatch de data.id entre query y body', () => {
  const same = buildWebhookEventRecord(sampleInput());
  assert.equal(same.queryDataIdPresent, true);
  assert.equal(same.queryDataIdLength, PAYMENT_ID.length);
  assert.equal(same.queryDataIdMatchesBody, true);

  const differ = buildWebhookEventRecord(sampleInput({ queryDataId: '111', bodyDataId: '222' }));
  assert.equal(differ.queryDataIdMatchesBody, false);

  // Falta el body: no hay con qué comparar → null (distinto de "no coinciden").
  const onlyQuery = buildWebhookEventRecord(sampleInput({ bodyDataId: null }));
  assert.equal(onlyQuery.queryDataIdPresent, true);
  assert.equal(onlyQuery.queryDataIdMatchesBody, null);

  // No vino en query: no se puede comparar y la presencia es false.
  const noQuery = buildWebhookEventRecord(
    sampleInput({ queryDataId: null, bodyDataId: PAYMENT_ID, dataId: PAYMENT_ID }),
  );
  assert.equal(noQuery.queryDataIdPresent, false);
  assert.equal(noQuery.queryDataIdLength, null);
  assert.equal(noQuery.queryDataIdMatchesBody, null);
});

// =============================================================================
//  A. Firma válida → signatureOk=true y outcome 200 (comportamiento intacto)
// =============================================================================
test('A. firma válida → signatureOk=true y outcome 200', () => {
  withSecret(SECRET, () => {
    const signature = verifyMercadoPagoWebhookSignature({
      xSignature: `ts=${TS},v1=${HASH}`,
      xRequestId: REQUEST_ID,
      dataId: PAYMENT_ID,
    });
    assert.deepEqual(signature, { ok: true });

    const record = buildWebhookEventRecord(sampleInput());
    assert.equal(record.signatureHasV1, true);

    const outcome = webhookOutcome(signature.ok, null);
    assert.deepEqual(outcome, { result: 'signature_ok', httpStatus: 200 });
  });
});

// =============================================================================
//  B. Firma inválida → signatureOk=false y la ruta SIGUE devolviendo 401
// =============================================================================
test('B. firma inválida → signatureOk=false y outcome 401 (sigue rechazando)', () => {
  withSecret(SECRET, () => {
    const forged = sign(`id:${PAYMENT_ID};request-id:${REQUEST_ID};ts:${TS};`, 'otro-secreto');
    const signature = verifyMercadoPagoWebhookSignature({
      xSignature: `ts=${TS},v1=${forged}`,
      xRequestId: REQUEST_ID,
      dataId: PAYMENT_ID,
    });

    assert.equal(signature.ok, false);
    if (!signature.ok) {
      assert.equal(signature.reason, 'SignatureMismatch');
      const outcome = webhookOutcome(signature.ok, signature.reason);
      assert.equal(outcome.httpStatus, 401);
      assert.equal(outcome.result, 'invalid_signature:SignatureMismatch');
    }
  });
});

// =============================================================================
//  E. El fallo del registro no cambia el comportamiento funcional
// =============================================================================
test('E. si el INSERT de observabilidad falla, no lanza (best-effort)', async () => {
  let attempted = false;
  const failingSql = (() => {
    attempted = true;
    throw new Error('simulated db failure');
  }) as never;

  await assert.doesNotReject(async () => {
    await recordPaymentWebhookEvent(
      {
        receivedAt: new Date().toISOString(),
        record: buildWebhookEventRecord(sampleInput()),
        signatureOk: false,
        result: 'invalid_signature:SignatureMismatch',
        httpStatus: 401,
      },
      { sql: failingSql },
    );
  });

  assert.equal(attempted, true, 'debe haber INTENTADO persistir y tragarse el error');
});

test('E2. sql=null desactiva la persistencia y resuelve sin lanzar', async () => {
  await assert.doesNotReject(() =>
    recordPaymentWebhookEvent(
      {
        receivedAt: new Date().toISOString(),
        record: buildWebhookEventRecord(sampleInput()),
        signatureOk: null,
        result: 'mercadopago_not_configured',
        httpStatus: 503,
      },
      { sql: null },
    ),
  );
});

// =============================================================================
//  Resumen del header de firma (robustez del parser)
// =============================================================================
test('summarizeSignatureHeader: maneja ausencia, orden, espacios y claves desconocidas', () => {
  assert.deepEqual(summarizeSignatureHeader(null), {
    present: false,
    hasTs: false,
    hasV1: false,
    tsLength: null,
    v1Length: null,
  });

  // Orden invertido + espacios: debe reconocer ambos pares.
  const reversed = summarizeSignatureHeader(` v1=${HASH} , ts=${TS} `);
  assert.equal(reversed.present, true);
  assert.equal(reversed.hasTs, true);
  assert.equal(reversed.hasV1, true);
  assert.equal(reversed.tsLength, TS.length);
  assert.equal(reversed.v1Length, HASH.length);

  // Solo v1 (sin ts): hasTs=false, tsLength=null.
  const onlyV1 = summarizeSignatureHeader(`v1=${HASH}`);
  assert.equal(onlyV1.hasTs, false);
  assert.equal(onlyV1.tsLength, null);
  assert.equal(onlyV1.hasV1, true);

  // Basura sin `=`: no debe romper.
  const garbage = summarizeSignatureHeader('scanner');
  assert.equal(garbage.present, true);
  assert.equal(garbage.hasTs, false);
  assert.equal(garbage.hasV1, false);
});

test('buildWebhookEventRecord: acota user-agent largo y nunca lanza con entradas nulas', () => {
  const record = buildWebhookEventRecord(
    sampleInput({ userAgent: 'x'.repeat(1000), xSignature: null, xRequestId: null }),
  );
  assert.equal(record.userAgent?.length, 300);
  assert.equal(record.xSignaturePresent, false);
  assert.equal(record.tsLength, null);
  assert.equal(record.v1Length, null);
  assert.equal(record.xRequestIdPresent, false);
  assert.equal(record.xRequestIdLength, null);
});
