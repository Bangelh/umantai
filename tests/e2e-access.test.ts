/**
 * tests/e2e-access.test.ts — la puerta del E2E no es una puerta trasera.
 *
 * El endpoint del outbox y el cupo alto de auth exigen flag de test + secreto
 * compartido, comparado en tiempo constante. Nada de eso se abre en Producción
 * ni sin `E2E_TEST_TOKEN`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  E2E_TOKEN_HEADER,
  hasValidE2EToken,
  isE2EConfigured,
  isE2ERequest,
} from '../lib/e2e-access.server';

const TOKEN = 'e2e-token-de-prueba-0123456789';

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of ['AUTH_TEST_MODE', 'APP_ENV', 'E2E_TEST_TOKEN']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const requestWith = (token?: string) =>
  new Request('https://umantai.com/api/auth/test/outbox', {
    headers: token === undefined ? {} : { [E2E_TOKEN_HEADER]: token },
  });

test('sin AUTH_TEST_MODE no está configurado aunque haya token', () => {
  withEnv({ APP_ENV: 'staging', E2E_TEST_TOKEN: TOKEN }, () => {
    assert.equal(isE2EConfigured(), false);
    assert.equal(isE2ERequest(requestWith(TOKEN)), false);
  });
});

test('en Producción nunca está configurado', () => {
  withEnv({ APP_ENV: 'production', AUTH_TEST_MODE: '1', E2E_TEST_TOKEN: TOKEN }, () => {
    assert.equal(isE2EConfigured(), false);
    assert.equal(hasValidE2EToken(TOKEN), false);
  });
});

test('sin E2E_TEST_TOKEN el endpoint queda cerrado', () => {
  withEnv({ APP_ENV: 'staging', AUTH_TEST_MODE: '1' }, () => {
    assert.equal(isE2EConfigured(), false);
    assert.equal(hasValidE2EToken(''), false);
    assert.equal(hasValidE2EToken(TOKEN), false);
  });
});

test('un token corto no se acepta como secreto', () => {
  withEnv({ APP_ENV: 'staging', AUTH_TEST_MODE: '1', E2E_TEST_TOKEN: 'corto' }, () => {
    assert.equal(isE2EConfigured(), false);
  });
});

test('token correcto abre la puerta; token incorrecto o ausente no', () => {
  withEnv({ APP_ENV: 'staging', AUTH_TEST_MODE: '1', E2E_TEST_TOKEN: TOKEN }, () => {
    assert.equal(isE2EConfigured(), true);
    assert.equal(isE2ERequest(requestWith(TOKEN)), true);

    assert.equal(isE2ERequest(requestWith()), false);
    assert.equal(isE2ERequest(requestWith('otro-token-de-prueba-0123456789')), false);
    assert.equal(isE2ERequest(requestWith(`${TOKEN} `)), true); // se recorta el espacio
    assert.equal(isE2ERequest(requestWith(`${TOKEN}x`)), false);
  });
});
