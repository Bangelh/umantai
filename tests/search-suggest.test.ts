import test from 'node:test';
import assert from 'node:assert/strict';

import { splitHighlight } from '../lib/search-suggest';

test('resalta lo escrito sin importar mayúsculas', () => {
  assert.deepEqual(splitHighlight('Camisa manga corta', 'CAMI'), [
    { text: 'Cami', match: true },
    { text: 'sa manga corta', match: false },
  ]);
});

test('resalta la coincidencia en medio de la sugerencia', () => {
  assert.deepEqual(splitHighlight('Polo azul', 'az'), [
    { text: 'Polo ', match: false },
    { text: 'az', match: true },
    { text: 'ul', match: false },
  ]);
});

test('quien escribe sin tilde encuentra la sugerencia con tilde y la marca', () => {
  assert.deepEqual(splitHighlight('Camisá de algodón', 'camisa'), [
    { text: 'Camisá', match: true },
    { text: ' de algodón', match: false },
  ]);
});

test('quien escribe con tilde también marca la sugerencia', () => {
  assert.deepEqual(splitHighlight('Camisa de algodón', 'camisá'), [
    { text: 'Camisa', match: true },
    { text: ' de algodón', match: false },
  ]);
});

test('sin coincidencia o sin consulta devuelve el texto completo sin marcar', () => {
  assert.deepEqual(splitHighlight('Polo azul', 'xyz'), [{ text: 'Polo azul', match: false }]);
  assert.deepEqual(splitHighlight('Polo azul', '   '), [{ text: 'Polo azul', match: false }]);
  assert.deepEqual(splitHighlight('', 'polo'), [{ text: '', match: false }]);
});
