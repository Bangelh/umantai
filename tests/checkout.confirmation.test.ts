import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCheckoutSummary,
  canSubmitOrder,
  isValidContactEmail,
  parseOrderErrorPayload,
  transitionCheckout,
  type CheckoutPhase,
} from '../lib/checkout';

/**
 * Confirmación de compra: el pedido solo se crea después de "Confirmar compra".
 * La máquina de estados es la que impide dobles envíos; se prueba sin DOM.
 */

test('confirmar compra: cart → confirming → submitting → created', () => {
  let phase: CheckoutPhase = 'cart';
  phase = transitionCheckout(phase, 'open');
  assert.equal(phase, 'confirming');
  assert.equal(canSubmitOrder(phase), false);

  phase = transitionCheckout(phase, 'confirm');
  assert.equal(phase, 'submitting');
  assert.equal(canSubmitOrder(phase), true);

  phase = transitionCheckout(phase, 'success');
  assert.equal(phase, 'created');
});

test('cancelar la confirmación vuelve al carrito y no deja fase de envío', () => {
  const phase = transitionCheckout('confirming', 'cancel');
  assert.equal(phase, 'cart');
  assert.equal(canSubmitOrder(phase), false);
});

test('doble clic: confirmar dos veces no vuelve a disparar la petición', () => {
  const submitting = transitionCheckout('confirming', 'confirm');
  const secondClick = transitionCheckout(submitting, 'confirm');
  assert.equal(secondClick, 'submitting');
  assert.equal(canSubmitOrder(secondClick), true);

  const thirdClick = transitionCheckout(secondClick, 'confirm');
  assert.equal(thirdClick, 'submitting');
});

test('cancelar durante el envío no cancela el pedido en curso', () => {
  assert.equal(transitionCheckout('submitting', 'cancel'), 'submitting');
});

test('un fallo de red vuelve a la confirmación para reintentar', () => {
  assert.equal(transitionCheckout('submitting', 'failure'), 'confirming');
});

test('el resumen muestra producto, variante, cantidad, unitario y total', () => {
  const summary = buildCheckoutSummary([
    {
      name: 'iPhone 15 Pro',
      brand: 'Apple',
      price: 999,
      quantity: 2,
      variant: { color: 'Black Titanium', storage: '256GB' },
    },
    { name: 'Paltas Hass', price: 7.9, quantity: 3, variant: {} },
  ]);

  assert.equal(summary.lines.length, 2);
  assert.equal(summary.lines[0].variantLabel, 'Black Titanium · 256GB');
  assert.equal(summary.lines[0].unitPrice, 999);
  assert.equal(summary.lines[0].lineTotal, 1998);
  assert.equal(summary.lines[1].variantLabel, null);
  assert.equal(summary.itemCount, 5);
  assert.equal(summary.subtotal, 2021.7);
  assert.equal(summary.total, 2021.7);
});

test('email inválido no permite abrir la confirmación', () => {
  assert.equal(isValidContactEmail('buyer@example.com'), true);
  assert.equal(isValidContactEmail(' buyer@example.com '), true);
  assert.equal(isValidContactEmail('buyer@'), false);
  assert.equal(isValidContactEmail(''), false);
});

test('el 409 de stock se parsea con los SKU que faltan', () => {
  const parsed = parseOrderErrorPayload({
    error: 'Sorry, some items just sold out. Please review your cart.',
    code: 'insufficient_stock',
    details: {
      items: [
        {
          productSlug: 'oura-ring-gen3',
          productName: 'Oura Ring Gen3',
          variantKey: 'color:stealth',
          requested: 3,
          available: 1,
        },
      ],
    },
  });

  assert.equal(parsed.code, 'insufficient_stock');
  assert.equal(parsed.shortages.length, 1);
  assert.equal(parsed.shortages[0].productName, 'Oura Ring Gen3');
  assert.equal(parsed.shortages[0].requested, 3);
  assert.equal(parsed.shortages[0].available, 1);
});

test('un error sin details sigue siendo un mensaje utilizable', () => {
  const parsed = parseOrderErrorPayload({ error: 'Failed to create order' });
  assert.equal(parsed.code, null);
  assert.equal(parsed.shortages.length, 0);
  assert.equal(parsed.message, 'Failed to create order');

  const fallback = parseOrderErrorPayload(null);
  assert.match(fallback.message, /could not place your order/i);
});
