/**
 * tests/email-routing.test.ts — a quién le toca outbox y a quién Resend.
 *
 * Regla que se protege: en staging `AUTH_TEST_MODE=1` NO puede desviar los
 * correos de una persona real. Solo los destinatarios `@umantai.test` (TLD
 * reservado por la RFC 2606) caen en `email_outbox`; el resto sale por Resend.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isTestRecipient, resolveEmailProviderName, TEST_RECIPIENT_DOMAIN } from '../lib/email.server';

// Sin `NODE_ENV`: es de solo lectura en los tipos y no participa de la decisión.
const KEYS = ['AUTH_TEST_MODE', 'APP_ENV', 'RESEND_API_KEY', 'VERCEL_ENV'] as const;

function withEnv(values: Partial<Record<(typeof KEYS)[number], string>>, run: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    run();
  } finally {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('el dominio de prueba es el TLD reservado umantai.test', () => {
  assert.equal(TEST_RECIPIENT_DOMAIN, 'umantai.test');
});

test('isTestRecipient compara el dominio completo, no un substring', () => {
  assert.equal(isTestRecipient('e2e-auth+1@umantai.test'), true);
  assert.equal(isTestRecipient('otro@sub.umantai.test'), true);
  assert.equal(isTestRecipient('E2E@UMANTAI.TEST'), true);
  assert.equal(isTestRecipient('e2e@umantai.test.evil.com'), false);
  assert.equal(isTestRecipient('e2e@notumantai.test'), false);
  assert.equal(isTestRecipient('persona@gmail.com'), false);
  assert.equal(isTestRecipient('sin-arroba'), false);
});

test('staging con AUTH_TEST_MODE=1: E2E al outbox, persona real a Resend', () => {
  withEnv({ APP_ENV: 'staging', AUTH_TEST_MODE: '1', RESEND_API_KEY: 're_test' }, () => {
    assert.equal(resolveEmailProviderName('e2e-auth+1@umantai.test'), 'test');
    assert.equal(resolveEmailProviderName('omar@gmail.com'), 'resend');
  });
});

test('AUTH_TEST_MODE=0: el destinatario de prueba falla cerrado, no sale por Resend', () => {
  withEnv({ APP_ENV: 'staging', AUTH_TEST_MODE: '0', RESEND_API_KEY: 're_test' }, () => {
    assert.equal(resolveEmailProviderName('e2e-auth+1@umantai.test'), 'disabled');
    assert.equal(resolveEmailProviderName('omar@gmail.com'), 'resend');
  });
});

test('Producción ignora AUTH_TEST_MODE por completo', () => {
  withEnv({ APP_ENV: 'production', AUTH_TEST_MODE: '1', RESEND_API_KEY: 're_test' }, () => {
    // Ni siquiera un @umantai.test se guarda en outbox en Producción.
    assert.equal(resolveEmailProviderName('e2e-auth+1@umantai.test'), 'disabled');
    assert.equal(resolveEmailProviderName('omar@gmail.com'), 'resend');
  });
});

test('sin API key, el correo real queda disabled (no se finge un envío)', () => {
  withEnv({ APP_ENV: 'staging', AUTH_TEST_MODE: '1' }, () => {
    assert.equal(resolveEmailProviderName('omar@gmail.com'), 'disabled');
  });
});

test('sin destinatario se resuelve el provider de correo real', () => {
  withEnv({ APP_ENV: 'staging', AUTH_TEST_MODE: '1', RESEND_API_KEY: 're_test' }, () => {
    assert.equal(resolveEmailProviderName(), 'resend');
  });
});
