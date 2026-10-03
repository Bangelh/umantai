import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { verifyMercadoPagoWebhookSignature } from '../lib/mercadopago.server';

/**
 * Firma de webhooks de Mercado Pago — tests de REGRESIÓN.
 *
 * No hay red ni base de datos acá: se ejercita el validador real que usa la ruta
 * (`verifyMercadoPagoWebhookSignature` → `WebhookSignatureValidator` del SDK oficial)
 * contra el manifest que Mercado Pago documenta:
 *
 *     id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 *
 * con la regla de OMITIR los pares cuyo valor no está presente.
 *
 * Estos tests fijan el comportamiento correcto para que ninguna refactorización
 * futura lo rompa. Cubren los seis escenarios pedidos en la auditoría.
 */

const SECRET = 'unit-test-webhook-secret';

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

/** Construye el manifest EXACTAMENTE como lo documenta Mercado Pago (pares presentes). */
function officialManifest(parts: {
  dataId?: string | null;
  xRequestId?: string | null;
  ts: string;
}): string {
  const segments: string[] = [];
  if (parts.dataId) segments.push(`id:${parts.dataId}`);
  if (parts.xRequestId) segments.push(`request-id:${parts.xRequestId}`);
  segments.push(`ts:${parts.ts}`);
  return `${segments.join(';')};`;
}

function sign(manifest: string, secret: string = SECRET): string {
  return createHmac('sha256', secret).update(manifest).digest('hex');
}

/** `x-signature` tal como lo manda Mercado Pago: `ts=<ts>,v1=<hash>`. */
function signatureHeader(ts: string, hash: string): string {
  return `ts=${ts},v1=${hash}`;
}

const REQUEST_ID = '5e278faa-87ac-48e9-8ebd-567f2d341302';
const PAYMENT_ID = '181116819289';
const TS = '1764699137';

// =============================================================================
//  1. Notificación real bien formada (query data.id + x-request-id + x-signature)
// =============================================================================
test('firma: manifest oficial con data.id de query → válida', () => {
  withSecret(SECRET, () => {
    const manifest = officialManifest({ dataId: PAYMENT_ID, xRequestId: REQUEST_ID, ts: TS });
    assert.equal(manifest, `id:${PAYMENT_ID};request-id:${REQUEST_ID};ts:${TS};`);

    const result = verifyMercadoPagoWebhookSignature({
      xSignature: signatureHeader(TS, sign(manifest)),
      xRequestId: REQUEST_ID,
      dataId: PAYMENT_ID,
    });

    assert.deepEqual(result, { ok: true });
  });
});

// =============================================================================
//  2. Misma notificación con firma incorrecta → inválida
// =============================================================================
test('firma: hash incorrecto → inválida (SignatureMismatch)', () => {
  withSecret(SECRET, () => {
    const manifest = officialManifest({ dataId: PAYMENT_ID, xRequestId: REQUEST_ID, ts: TS });

    // Hash calculado con OTRO secreto: simula una firma forjada.
    const forged = sign(manifest, 'a-different-secret');
    const result = verifyMercadoPagoWebhookSignature({
      xSignature: signatureHeader(TS, forged),
      xRequestId: REQUEST_ID,
      dataId: PAYMENT_ID,
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'SignatureMismatch');
  });
});

// =============================================================================
//  3. Query data.id y body data.id DIFERENTES → se verifica con el de QUERY
// =============================================================================
test('firma: si query y body difieren, vale el data.id de QUERY', () => {
  withSecret(SECRET, () => {
    const queryDataId = '222222222222';
    const bodyDataId = '999999999999'; // distinto

    // MP firmó con el id de la query.
    const manifest = officialManifest({ dataId: queryDataId, xRequestId: REQUEST_ID, ts: TS });
    const xSignature = signatureHeader(TS, sign(manifest));

    // La ruta prioriza la query → válida.
    const fromQuery = verifyMercadoPagoWebhookSignature({
      xSignature,
      xRequestId: REQUEST_ID,
      dataId: queryDataId,
    });
    assert.deepEqual(fromQuery, { ok: true });

    // Si se usara el id del body, NO validaría: confirma que la query es la fuente.
    const fromBody = verifyMercadoPagoWebhookSignature({
      xSignature,
      xRequestId: REQUEST_ID,
      dataId: bodyDataId,
    });
    assert.equal(fromBody.ok, false);
  });
});

// =============================================================================
//  4. Valor ausente → ese par se OMITE del manifest
// =============================================================================
test('firma: pares ausentes se omiten del manifest (request-id y data.id)', () => {
  withSecret(SECRET, () => {
    // (a) Sin x-request-id: manifest = id:...;ts:...;
    const withoutRequestId = officialManifest({ dataId: PAYMENT_ID, xRequestId: null, ts: TS });
    assert.equal(withoutRequestId, `id:${PAYMENT_ID};ts:${TS};`);
    const a = verifyMercadoPagoWebhookSignature({
      xSignature: signatureHeader(TS, sign(withoutRequestId)),
      xRequestId: null,
      dataId: PAYMENT_ID,
    });
    assert.deepEqual(a, { ok: true });

    // Un par vacío NO debe formar parte del manifest: `request-id:;` no valida.
    const withEmptyPair = `id:${PAYMENT_ID};request-id:;ts:${TS};`;
    const b = verifyMercadoPagoWebhookSignature({
      xSignature: signatureHeader(TS, sign(withEmptyPair)),
      xRequestId: null,
      dataId: PAYMENT_ID,
    });
    assert.equal(b.ok, false);

    // (b) Sin data.id: manifest = request-id:...;ts:...;
    const withoutDataId = officialManifest({ dataId: null, xRequestId: REQUEST_ID, ts: TS });
    assert.equal(withoutDataId, `request-id:${REQUEST_ID};ts:${TS};`);
    const c = verifyMercadoPagoWebhookSignature({
      xSignature: signatureHeader(TS, sign(withoutDataId)),
      xRequestId: REQUEST_ID,
      dataId: null,
    });
    assert.deepEqual(c, { ok: true });
  });
});

// =============================================================================
//  5. ID alfanumérico con mayúsculas → se conserva el CASE original
// =============================================================================
test('firma: data.id con mayúsculas conserva su case (regla oficial del SDK)', () => {
  withSecret(SECRET, () => {
    const dataId = 'ORDER123ABC';
    const manifest = officialManifest({ dataId, xRequestId: REQUEST_ID, ts: TS });
    assert.equal(manifest, `id:ORDER123ABC;request-id:${REQUEST_ID};ts:${TS};`);

    const ok = verifyMercadoPagoWebhookSignature({
      xSignature: signatureHeader(TS, sign(manifest)),
      xRequestId: REQUEST_ID,
      dataId,
    });
    assert.deepEqual(ok, { ok: true });

    // Bajar a minúsculas rompería la firma (MP firma con el case original).
    const lowercased = officialManifest({ dataId: dataId.toLowerCase(), xRequestId: REQUEST_ID, ts: TS });
    const broken = verifyMercadoPagoWebhookSignature({
      xSignature: signatureHeader(TS, sign(lowercased)),
      xRequestId: REQUEST_ID,
      dataId,
    });
    assert.equal(broken.ok, false);
  });
});

// =============================================================================
//  6. Regresión: el caso equivalente al simulador oficial sigue siendo válido
// =============================================================================
test('firma: regresión del simulador (payment.created) → válida', () => {
  withSecret(SECRET, () => {
    const manifest = officialManifest({ dataId: '182124944920', xRequestId: REQUEST_ID, ts: TS });
    const result = verifyMercadoPagoWebhookSignature({
      xSignature: signatureHeader(TS, sign(manifest)),
      xRequestId: REQUEST_ID,
      dataId: '182124944920',
    });
    assert.deepEqual(result, { ok: true });
  });
});

// =============================================================================
//  Guardas: sin secreto no existe validación posible
// =============================================================================
test('firma: sin MERCADOPAGO_WEBHOOK_SECRET lanza (nunca acepta a ciegas)', () => {
  withSecret(null, () => {
    assert.throws(
      () =>
        verifyMercadoPagoWebhookSignature({
          xSignature: signatureHeader(TS, sign(officialManifest({ dataId: PAYMENT_ID, ts: TS }))),
          xRequestId: null,
          dataId: PAYMENT_ID,
        }),
      /mercadopago_webhook_secret_not_configured/,
    );
  });
});
