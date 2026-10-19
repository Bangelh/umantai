/**
 * tests/contact.test.ts — formulario de contacto.
 *
 * Cubre validación server-side, honeypot, rate limit y la degradación cuando no
 * hay base ni Resend configurados (el caso real de hoy): nunca debe fingir que
 * el mensaje se recibió.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONTACT_LIMITS, validateContactPayload } from '../lib/contact';
import {
  getContactRecipient,
  isContactEmailConfigured,
  isContactStorageConfigured,
  submitContactMessage,
} from '../lib/contact.server';
import { consumeRateLimit, resetRateLimits } from '../lib/rate-limit.server';

const VALID = {
  name: 'Ana Pérez',
  email: 'ANA@Example.COM',
  phone: '+51 999 888 777',
  message: 'Hola, quisiera saber si tienen stock del producto de la foto.',
  consent: true,
  company: '',
};

test('payload válido: normaliza nombre, correo y mensaje', () => {
  const result = validateContactPayload({ ...VALID, name: '  Ana   Pérez  ' });
  assert.ok(result.ok);
  assert.equal(result.value.name, 'Ana Pérez');
  assert.equal(result.value.email, 'ana@example.com');
  assert.equal(result.value.phone, '+51 999 888 777');
  assert.equal(result.value.source, 'contact_page');
});

test('teléfono vacío se guarda como null (opcional de verdad)', () => {
  const result = validateContactPayload({ ...VALID, phone: '   ' });
  assert.ok(result.ok);
  assert.equal(result.value.phone, null);
});

test('errores por campo: nombre, correo, mensaje y consentimiento', () => {
  const result = validateContactPayload({
    name: 'A',
    email: 'no-es-correo',
    message: 'corto',
    consent: false,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.name);
  assert.ok(result.errors.email);
  assert.ok(result.errors.message);
  assert.ok(result.errors.consent);
});

test('honeypot: si `company` viene con datos, se descarta en silencio', () => {
  const result = validateContactPayload({ ...VALID, company: 'Acme Spam SA' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.spam, true);
  // No se le dice al bot qué campo lo delató.
  assert.deepEqual(result.errors, {});
});

test('mensaje demasiado largo y teléfono con letras se rechazan', () => {
  const long = validateContactPayload({
    ...VALID,
    message: 'x'.repeat(CONTACT_LIMITS.messageMax + 1),
  });
  assert.equal(long.ok, false);

  const badPhone = validateContactPayload({ ...VALID, phone: 'llámame al fijo' });
  assert.equal(badPhone.ok, false);
  if (!badPhone.ok) assert.ok(badPhone.errors.phone);
});

test('cuerpo no-objeto se rechaza sin lanzar', () => {
  for (const raw of [null, 'texto', 42, []]) {
    const result = validateContactPayload(raw);
    assert.equal(result.ok, false);
  }
});

test('rate limit: corta la sexta ráfaga y se reinicia', () => {
  resetRateLimits();
  const key = `contact:test-${Math.random()}`;
  for (let index = 0; index < 5; index += 1) {
    assert.equal(consumeRateLimit(key, 5, 60_000).allowed, true, `intento ${index + 1}`);
  }
  const blocked = consumeRateLimit(key, 5, 60_000);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);

  resetRateLimits();
  assert.equal(consumeRateLimit(key, 5, 60_000).allowed, true);
});

test('configuración incompleta: no se anuncia como disponible', async () => {
  const saved = {
    apiKey: process.env.RESEND_API_KEY,
    to: process.env.CONTACT_TO_EMAIL,
    db: process.env.POSTGRES_URL_NON_POOLING,
    db2: process.env.POSTGRES_URL,
    db3: process.env.DATABASE_URL,
  };
  delete process.env.RESEND_API_KEY;
  delete process.env.CONTACT_TO_EMAIL;
  delete process.env.POSTGRES_URL_NON_POOLING;
  delete process.env.POSTGRES_URL;
  delete process.env.DATABASE_URL;

  try {
    assert.equal(getContactRecipient(), null);
    assert.equal(isContactEmailConfigured(), false);
    assert.equal(isContactStorageConfigured(), false);

    // Sin DB y sin Resend: el resultado es explícito, no un falso "enviado".
    const result = await submitContactMessage({
      name: VALID.name,
      email: 'ana@example.com',
      phone: null,
      message: VALID.message,
      source: 'contact_page',
    });
    assert.equal(result.delivery, 'unavailable');
    assert.equal(result.emailStatus, 'not_configured');
    assert.equal(result.id, null);
  } finally {
    if (saved.apiKey !== undefined) process.env.RESEND_API_KEY = saved.apiKey;
    if (saved.to !== undefined) process.env.CONTACT_TO_EMAIL = saved.to;
    if (saved.db !== undefined) process.env.POSTGRES_URL_NON_POOLING = saved.db;
    if (saved.db2 !== undefined) process.env.POSTGRES_URL = saved.db2;
    if (saved.db3 !== undefined) process.env.DATABASE_URL = saved.db3;
  }
});
