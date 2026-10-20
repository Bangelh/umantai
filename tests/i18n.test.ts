/**
 * tests/i18n.test.ts — contrato de la interfaz bilingüe.
 *
 * No traduce contenido de tiendas: solo valida que ambas interfaces tengan las
 * mismas claves, que la interpolación sea segura y que el locale se normalice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MESSAGES } from '../lib/i18n/dictionaries';
import { resolveLocale } from '../lib/i18n/config';
import { translate } from '../lib/i18n';

test('es y en tienen exactamente las mismas claves y ninguna vacía', () => {
  const es = Object.keys(MESSAGES.es).sort();
  const en = Object.keys(MESSAGES.en).sort();

  assert.deepEqual(en, es);
  for (const locale of ['es', 'en'] as const) {
    for (const [key, value] of Object.entries(MESSAGES[locale])) {
      assert.ok(value.trim().length > 0, `${locale}.${key} está vacío`);
    }
  }
});

test('traduce y interpola variables sin evaluar HTML', () => {
  assert.equal(translate('es', 'nav.home'), 'Inicio');
  assert.equal(translate('en', 'nav.home'), 'Home');
  assert.equal(
    translate('es', 'store.available', { count: 12 }),
    '12 disponibles',
  );
  assert.equal(
    translate('en', 'store.searchLabel', { store: '<b>Hola</b>' }),
    'Search in <b>Hola</b>',
  );
});

test('una variable ausente se deja visible, no se convierte en undefined', () => {
  assert.equal(translate('en', 'billing.keep'), 'Keep {plan}');
});

test('normaliza locales regionales y cae a español', () => {
  assert.equal(resolveLocale('en-US'), 'en');
  assert.equal(resolveLocale('es-PE'), 'es');
  assert.equal(resolveLocale('fr-FR'), 'es');
  assert.equal(resolveLocale(null), 'es');
});
