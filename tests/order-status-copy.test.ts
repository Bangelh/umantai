/**
 * tests/order-status-copy.test.ts — el copy de estados tiene UNA fuente.
 *
 * Cubre los hallazgos de la compra manual:
 *   · `pending_payment` se le muestra al comerciante como "Esperando pago" y con la
 *     advertencia de no preparar;
 *   · ningún estado queda sin explicación ni sin siguiente acción;
 *   · "Retiro en casillero" no existe en ninguna superficie del cliente/merchant;
 *   · el copy del pago congelado no promete pagar después de que la reserva venza;
 *   · "Seguir comprando" lleva una sola flecha (la del JSX, no la del diccionario).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ORDER_STATUSES, PAYMENT_STATUSES } from '../lib/commerce';
import { MESSAGES } from '../lib/i18n/dictionaries';
import {
  isOrderActionable,
  merchantOrderStatusKey,
  orderStatusCopy,
  paymentStatusKey,
} from '../lib/order-status-copy';

const ROOT = process.cwd();
const es = MESSAGES.es as Record<string, string>;
const en = MESSAGES.en as Record<string, string>;

const CUSTOMER_PAGE = 'app/pedido/[token]/page.tsx';
const MERCHANT_LIST = 'app/negocio/[storeId]/page.tsx';
const MERCHANT_DETAIL = 'app/negocio/[storeId]/pedidos/[orderId]/page.tsx';

test('cada estado tiene etiqueta, explicación y acción en es y en', () => {
  for (const status of ORDER_STATUSES) {
    const copy = orderStatusCopy(status);

    assert.ok(copy.labelKey, `${status}: sin labelKey`);
    assert.ok(copy.explanationKey, `${status}: sin explanationKey`);
    assert.ok(copy.actionKey, `${status}: sin actionKey`);

    for (const key of [copy.labelKey, copy.explanationKey, copy.actionKey]) {
      assert.ok(es[key], `es: falta "${key}" (${status})`);
      assert.ok(en[key], `en: falta "${key}" (${status})`);
    }
  }
});

test('cada estado de pago tiene etiqueta en es y en', () => {
  for (const status of PAYMENT_STATUSES) {
    const key = paymentStatusKey(status);
    assert.ok(es[key], `es: falta "${key}"`);
    assert.ok(en[key], `en: falta "${key}"`);
  }
});

test('pending_payment se explica como "Esperando pago" y NO se puede preparar', () => {
  assert.equal(merchantOrderStatusKey('pending_payment'), 'merchant.waitingPayment');
  assert.equal(es['merchant.waitingPayment'], 'Esperando pago');
  assert.equal(en['merchant.waitingPayment'], 'Waiting for payment');

  assert.equal(
    es['merchant.waitingPaymentWarning'],
    'No prepares este pedido todavía.',
    'el aviso de no preparar cambió o desapareció',
  );

  // Invariante de negocio: sin pago no hay preparación.
  assert.equal(isOrderActionable('pending_payment'), false, 'pending_payment no debe ser accionable');
  assert.doesNotMatch(
    es[orderStatusCopy('pending_payment').actionKey] ?? '',
    /^Prepara el pedido/,
    'la acción de pending_payment no debe invitar a preparar',
  );

  // Los estados que sí admite la máquina de estados siguen siendo accionables.
  for (const status of ['confirmed', 'preparing', 'ready_for_pickup'] as const) {
    assert.equal(isOrderActionable(status), true, `${status} debería ser accionable`);
  }
});

test('los pedidos cerrados quedan secundarios frente a los vivos', () => {
  for (const status of ['picked_up', 'delivered', 'completed', 'cancelled', 'expired', 'refunded'] as const) {
    assert.equal(orderStatusCopy(status).secondary, true, `${status} debería ir al historial`);
    assert.equal(orderStatusCopy(status).needsAttention, false, `${status} no requiere atención`);
  }
  for (const status of ['pending_payment', 'confirmed', 'preparing', 'ready_for_pickup'] as const) {
    assert.equal(orderStatusCopy(status).secondary, false, `${status} no es historial`);
  }
});

test('"Retiro en casillero" no aparece en las superficies del cliente ni del merchant', () => {
  assert.equal(es['order.fulfillment.pickup_locker'], 'Recojo en tienda');
  assert.equal(es['order.fulfillment.pickup_counter'], 'Recojo en tienda');
  assert.equal(en['order.fulfillment.pickup_locker'], 'Store pickup');

  for (const [locale, dictionary] of [
    ['es', es],
    ['en', en],
  ] as const) {
    const offending = Object.entries(dictionary)
      .filter(([key]) => key.startsWith('order.') || key.startsWith('merchant.'))
      .filter(([, value]) => /casillero|locker/i.test(value))
      .map(([key]) => key);
    assert.deepEqual(offending, [], `${locale}: copy de casillero en ${offending.join(', ')}`);
  }

  for (const file of [CUSTOMER_PAGE, MERCHANT_LIST, MERCHANT_DETAIL]) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /casillero|lockerSlot/i, `${file}: menciona un casillero inexistente`);
  }
});

test('el copy del pago congelado no promete pagar después de que la reserva venza', () => {
  const body = es['order.paymentUnavailableBody'] ?? '';
  const bodyUntil = es['order.paymentUnavailableBodyUntil'] ?? '';
  const bodyEn = en['order.paymentUnavailableBody'] ?? '';

  for (const [name, text] of [
    ['es (sin fecha)', body],
    ['es (con fecha)', bodyUntil],
    ['en', bodyEn],
  ] as const) {
    assert.doesNotMatch(
      text,
      /Cuando el pago vuelva a estar disponible|Once online payment is available again/i,
      `${name}: conserva la promesa de pagar más tarde`,
    );
    assert.match(text, /nuevo|new one/i, `${name}: no explica que habrá que hacer un pedido nuevo`);
    assert.match(text, /no se realizó ningún cobro|no charge was made/i, `${name}: no aclara que no hubo cobro`);
  }

  // Con fecha de expiración la reserva tiene hora concreta; sin ella, se avisa que vence.
  assert.match(bodyUntil, /\{date\}/, 'falta el marcador de hora de la reserva');
  assert.ok(es['order.paymentUnavailableBodyUntil'].includes('reservados hasta'));
});

test('"Seguir comprando" tiene una sola flecha', () => {
  assert.equal(es['order.continueShopping'], 'Seguir comprando');
  assert.equal(en['order.continueShopping'], 'Continue shopping');

  const source = readFileSync(join(ROOT, CUSTOMER_PAGE), 'utf8');
  const arrows = (source.match(/←/g) ?? []).length;
  assert.equal(arrows, 1, `la página del pedido pinta ${arrows} flechas en "Seguir comprando"`);
});

test('la lista del merchant abre un detalle con líneas y total', () => {
  const list = readFileSync(join(ROOT, MERCHANT_LIST), 'utf8');
  const detail = readFileSync(join(ROOT, MERCHANT_DETAIL), 'utf8');

  assert.match(list, /href=\{`\/negocio\/\$\{storeId\}\/pedidos\/\$\{order\.id\}`\}/, 'la fila no enlaza al detalle');
  assert.match(list, /min-h-16/, 'la fila no garantiza área táctil de 44 px o más');
  assert.match(detail, /merchant\.lines/, 'el detalle no lista las líneas');
  assert.match(detail, /merchant\.nextAction/, 'el detalle no indica la siguiente acción');
  assert.match(detail, /merchant\.paymentStatus/, 'el detalle no muestra el estado del pago');
  assert.match(detail, /order\.total/, 'el detalle no muestra el total');
});

test('el detail del merchant no filtra IDs técnicos a la vista', () => {
  const detail = readFileSync(join(ROOT, MERCHANT_DETAIL), 'utf8');
  assert.doesNotMatch(detail, /order\.id\s*<|>\{order\.id\}|\{storeId\}<\/|>\{storeId\}/, 'ID técnico visible');
});
