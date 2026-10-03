import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrderWithItems } from '../lib/commerce';
import {
  buildCheckoutPreferenceBody,
  isStoredPreferenceFresh,
  readStoredCheckoutPreference,
  resolveNotificationUrl,
  toStoredPreferenceSnapshot,
  type StoredCheckoutPreference,
} from '../lib/mercadopago.server';
import { getEnvDebugInfo } from '../lib/env';

/**
 * Observabilidad de Mercado Pago (Fase 1).
 *
 * No hay red ni base de datos acá: se prueban las decisiones puras que garantizan
 * que la URL de webhook que se ENVÍA sea la MISMA que se PERSISTE, y que el endpoint
 * de diagnóstico reporte presencia de configuración sin filtrar secretos.
 */

const PREVIEW_ORIGIN = 'https://umantai-git-feat-ecommerce-core-umantai.vercel.app';

function sampleOrder(): OrderWithItems {
  return {
    id: '1bee1e56-2eb0-4cc6-ae25-5cac7f47666f',
    orderNumber: 'UM-2026-001011',
    publicToken: '9dffe128-0f81-4fa5-9f77-1eeafaef8129',
    currency: 'PEN',
    total: 749,
    shippingTotal: 0,
    contactEmail: 'qa.mp.sandbox@example.com',
    contactPhone: null,
    metadata: {},
    items: [
      {
        id: '086a71e6-42c7-4026-8847-7250a4ce9d71',
        orderId: '1bee1e56-2eb0-4cc6-ae25-5cac7f47666f',
        lineNumber: 1,
        productSlug: 'dyson-v15-detect',
        productName: 'Dyson V15 Detect Absolute',
        productBrand: 'Dyson',
        imageUrl: null,
        variantKey: '',
        variant: {},
        quantity: 1,
        unitPrice: 749,
        discountAmount: 0,
        taxAmount: 0,
        lineTotal: 749,
      },
    ],
  } as unknown as OrderWithItems;
}

// =============================================================================
//  A. La URL enviada y la persistida son la MISMA cadena
// =============================================================================

test('resolveNotificationUrl: agrega el path del webhook y normaliza slashes finales', () => {
  assert.equal(
    resolveNotificationUrl(PREVIEW_ORIGIN),
    `${PREVIEW_ORIGIN}/api/payments/webhook`,
  );
  assert.equal(
    resolveNotificationUrl(`${PREVIEW_ORIGIN}/`),
    `${PREVIEW_ORIGIN}/api/payments/webhook`,
  );
  assert.equal(
    resolveNotificationUrl(`${PREVIEW_ORIGIN}///`),
    `${PREVIEW_ORIGIN}/api/payments/webhook`,
  );
});

test('preferencia nueva: notification_url === notificationUrl persistida', () => {
  const order = sampleOrder();
  const { body, notificationUrl } = buildCheckoutPreferenceBody(order, PREVIEW_ORIGIN);

  // 1. La URL que viaja a Mercado Pago es exactamente la resuelta.
  assert.equal(notificationUrl, `${PREVIEW_ORIGIN}/api/payments/webhook`);
  assert.equal(body.notification_url, notificationUrl);

  // 2. El snapshot que se persiste lleva esa MISMA cadena (sin recalcular).
  const stored: StoredCheckoutPreference = {
    preferenceId: '3228895377-172425bd-06e7-4686-b82a-1e2de2df9494',
    initPoint: 'https://sandbox.mercadopago.com.pe/checkout/v1/redirect?pref_id=x',
    sandboxInitPoint: 'https://sandbox.mercadopago.com.pe/checkout/v1/redirect?pref_id=x',
    notificationUrl,
    createdAt: '2026-10-03T01:11:37.505Z',
  };
  const snapshot = toStoredPreferenceSnapshot(stored);
  assert.equal(snapshot.mercadoPago.notificationUrl, body.notification_url);
  assert.equal(snapshot.mercadoPago.preferenceId, stored.preferenceId);
});

test('buildCheckoutPreferenceBody: back_urls y auto_return no cambian con el nuevo campo', () => {
  const order = sampleOrder();
  const { body } = buildCheckoutPreferenceBody(order, PREVIEW_ORIGIN);

  assert.equal(body.external_reference, 'UM-2026-001011');
  assert.equal(body.back_urls?.success, `${PREVIEW_ORIGIN}/pedido/${order.publicToken}?pago=exitoso`);
  assert.equal(body.back_urls?.pending, `${PREVIEW_ORIGIN}/pedido/${order.publicToken}?pago=pendiente`);
  assert.equal(body.back_urls?.failure, `${PREVIEW_ORIGIN}/pedido/${order.publicToken}?pago=fallido`);
  assert.equal(body.auto_return, 'approved');

  // En http (local) se omite auto_return, igual que antes del cambio.
  const local = buildCheckoutPreferenceBody(order, 'http://localhost:3000');
  assert.equal(local.body.auto_return, undefined);
});

// =============================================================================
//  C. Reuso: no inventa ni altera el snapshot existente
// =============================================================================

test('reuso: una preferencia fresca conserva su notificationUrl intacta', () => {
  const notificationUrl = `${PREVIEW_ORIGIN}/api/payments/webhook`;
  const stored: StoredCheckoutPreference = {
    preferenceId: '3228895377-172425bd-06e7-4686-b82a-1e2de2df9494',
    initPoint: 'https://sandbox.mercadopago.com.pe/checkout/v1/redirect?pref_id=x',
    sandboxInitPoint: 'https://sandbox.mercadopago.com.pe/checkout/v1/redirect?pref_id=x',
    notificationUrl,
    createdAt: new Date().toISOString(),
  };

  const now = Date.now();
  assert.equal(isStoredPreferenceFresh(stored, now), true);
  // Fuera de la ventana ya no se reutiliza (se generaría una nueva): idempotencia intacta.
  assert.equal(isStoredPreferenceFresh(stored, now + 11 * 60 * 1000), false);

  const read = readStoredCheckoutPreference({
    metadata: { payment: { mercadoPago: { ...stored } } },
  } as unknown as Pick<OrderWithItems, 'metadata'>);

  assert.equal(read?.notificationUrl, notificationUrl);
  assert.equal(read?.preferenceId, stored.preferenceId);
});

test('snapshot antiguo sin notificationUrl: se lee null, nunca se inventa', () => {
  const read = readStoredCheckoutPreference({
    metadata: {
      payment: {
        mercadoPago: {
          preferenceId: '3228895377-172425bd-06e7-4686-b82a-1e2de2df9494',
          initPoint: 'https://sandbox.mercadopago.com.pe/checkout/v1/redirect?pref_id=x',
          createdAt: '2026-10-03T01:11:37.505Z',
        },
      },
    },
  } as unknown as Pick<OrderWithItems, 'metadata'>);

  assert.equal(read?.notificationUrl, null);
});

// =============================================================================
//  B. /api/debug/env: presencia como booleanos, sin secretos
// =============================================================================

test('debug env: reporta presencia de MP y NUNCA expone token ni secret', () => {
  const TOKEN_SENTINEL = 'APP_USR-OBSERVABILITY-SENTINEL-TOKEN';
  const SECRET_SENTINEL = 'WEBHOOK-OBSERVABILITY-SENTINEL-SECRET';

  const previous = {
    token: process.env.MERCADOPAGO_ACCESS_TOKEN,
    secret: process.env.MERCADOPAGO_WEBHOOK_SECRET,
    sandbox: process.env.MERCADOPAGO_SANDBOX,
    backUrlBase: process.env.MERCADOPAGO_BACK_URL_BASE,
  };

  process.env.MERCADOPAGO_ACCESS_TOKEN = TOKEN_SENTINEL;
  process.env.MERCADOPAGO_WEBHOOK_SECRET = SECRET_SENTINEL;
  process.env.MERCADOPAGO_SANDBOX = 'true';
  process.env.MERCADOPAGO_BACK_URL_BASE = 'https://preview.example.com';

  try {
    const info = getEnvDebugInfo();

    assert.equal(info.mercadoPago.accessTokenConfigured, true);
    assert.equal(info.mercadoPago.webhookSecretConfigured, true);
    assert.equal(info.mercadoPago.sandboxConfigured, true);
    assert.equal(info.mercadoPago.sandboxEnabled, true);
    assert.equal(info.mercadoPago.backUrlBaseConfigured, true);
    assert.equal(info.mercadoPago.backUrlBaseProtocol, 'https');
    assert.equal(info.mercadoPago.backUrlBaseHost, 'preview.example.com');

    // El valor crudo no aparece en ninguna parte del diagnóstico.
    const serialized = JSON.stringify(info);
    assert.equal(serialized.includes(TOKEN_SENTINEL), false);
    assert.equal(serialized.includes(SECRET_SENTINEL), false);

    // No existen campos que devuelvan las credenciales.
    assert.equal('accessToken' in info.mercadoPago, false);
    assert.equal('webhookSecret' in info.mercadoPago, false);
    assert.equal('backUrlBase' in info.mercadoPago, false);
  } finally {
    restoreEnv('MERCADOPAGO_ACCESS_TOKEN', previous.token);
    restoreEnv('MERCADOPAGO_WEBHOOK_SECRET', previous.secret);
    restoreEnv('MERCADOPAGO_SANDBOX', previous.sandbox);
    restoreEnv('MERCADOPAGO_BACK_URL_BASE', previous.backUrlBase);
  }
});

test('debug env: sin variables de MP, todo queda en false sin lanzar', () => {
  const previous = {
    token: process.env.MERCADOPAGO_ACCESS_TOKEN,
    secret: process.env.MERCADOPAGO_WEBHOOK_SECRET,
    sandbox: process.env.MERCADOPAGO_SANDBOX,
  };

  delete process.env.MERCADOPAGO_ACCESS_TOKEN;
  delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
  delete process.env.MERCADOPAGO_SANDBOX;

  try {
    const info = getEnvDebugInfo();
    assert.equal(info.mercadoPago.accessTokenConfigured, false);
    assert.equal(info.mercadoPago.webhookSecretConfigured, false);
    assert.equal(info.mercadoPago.sandboxConfigured, false);
    assert.equal(info.mercadoPago.sandboxEnabled, false);
  } finally {
    restoreEnv('MERCADOPAGO_ACCESS_TOKEN', previous.token);
    restoreEnv('MERCADOPAGO_WEBHOOK_SECRET', previous.secret);
    restoreEnv('MERCADOPAGO_SANDBOX', previous.sandbox);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
