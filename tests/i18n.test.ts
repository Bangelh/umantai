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
import {
  ADMIN_NAV_LINKS,
  HELP_NAV_LINKS,
  LEGAL_NAV_LINKS,
  SHOP_NAV_LINKS,
} from '../lib/navigation';

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

/**
 * Regresión del P2 del footer: `lib/navigation.ts` guardaba el texto visible en
 * español, así que la página en inglés mostraba «Carrito» entre «Shop» y «Help».
 */
test('los enlaces de navegación guardan una clave i18n, nunca texto literal', () => {
  const groups = [SHOP_NAV_LINKS, LEGAL_NAV_LINKS, HELP_NAV_LINKS, ADMIN_NAV_LINKS];

  for (const group of groups) {
    for (const link of group) {
      assert.equal('label' in link, false, `${link.href} todavía tiene texto literal`);
      assert.ok(
        (MESSAGES.es as Record<string, string>)[link.labelKey],
        `falta es.${link.labelKey}`,
      );
      assert.ok(
        (MESSAGES.en as Record<string, string>)[link.labelKey],
        `falta en.${link.labelKey}`,
      );
      // Sin traducción, `translate` devuelve la propia clave: eso no es una etiqueta.
      assert.notEqual(translate('en', link.labelKey), link.labelKey, `en.${link.labelKey}`);
    }
  }
});

test('el footer en inglés no muestra ninguna etiqueta en español', () => {
  const english: Array<[Parameters<typeof translate>[1], string]> = [
    ['navLink.products', 'Products'],
    ['nav.shoppingList', 'Shopping list'],
    ['nav.cart', 'Cart'],
    ['navLink.storePickup', 'Store pickup'],
    ['legal.privacy', 'Privacy'],
    ['legal.terms', 'Terms'],
    ['navLink.refunds', 'Refunds'],
    ['navLink.legalNotice', 'Legal notice'],
    ['navLink.contact', 'Contact'],
    ['navLink.complaintsBook', 'Complaints Book'],
    ['navLink.legalDocuments', 'Legal documents'],
  ];

  for (const [key, expected] of english) {
    assert.equal(translate('en', key), expected, `en.${key}`);
  }

  // Y el español conserva lo que ya estaba publicado.
  assert.equal(translate('es', 'navLink.products'), 'Productos');
  assert.equal(translate('es', 'navLink.complaintsBook'), 'Libro de Reclamaciones');
  assert.equal(translate('es', 'nav.cart'), 'Carrito');
});
