/**
 * tests/ui-classes.test.ts — guarda contra clases Tailwind pegadas sin espacio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE
 *
 *  En una pasada de tipografía se reemplazó `text-sm` por `text-body-lg` sin
 *  respetar el espacio anterior. El resultado fueron clases inexistentes:
 *
 *      bg-brandtext-body-lg          (CTA "Revisar pedido": sin fondo)
 *      font-monotext-body-lg         (importes sin la escala correcta)
 *      justify-betweentext-body-lg
 *
 *  Tailwind ignora en silencio un token que no conoce, así que el elemento se
 *  renderiza sin fondo y con `text-background` encima del fondo de la página:
 *  interactivo, invisible, y ningún test lo detectaba. Este test recorre las
 *  clases literales del código y falla ante cualquier token que empiece donde
 *  debía haber un espacio.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SOURCE_DIRS = ['app', 'components'];

/**
 * Un token válido precedido por otro carácter alfanumérico: la firma exacta de
 * una concatenación accidental. La lista de prefijos es la de las utilidades que
 * ya aparecieron pegadas en este repo; ampliarla es más barato que un bug visual.
 *
 * No se incluyen familias como `h-`/`w-`: `shadow-2xl` contiene `w-2`, y el test
 * debe fallar solo por clases realmente inexistentes, no por subcadenas.
 */
const GLUED_UTILITY =
  /[A-Za-z0-9](?:text-(?:body|body-lg|meta|title|display)|bg-(?:brand|surface|surface-raised|background)|border-(?:border|border-strong)|font-(?:mono|semibold|medium)|rounded-[a-z0-9]|justify-(?:between|center|end)|items-(?:center|start|end)|px-\d|py-\d|gap-\d)/;

interface Finding {
  file: string;
  line: number;
  token: string;
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const relative = join(dir, entry);
    const absolute = join(ROOT, relative);
    if (statSync(absolute).isDirectory()) sourceFiles(relative, found);
    else if (entry.endsWith('.tsx')) found.push(relative);
  }
  return found;
}

/** Extrae las cadenas de `className` (literal y template) con su línea. */
function classStrings(source: string): Array<{ value: string; line: number }> {
  const values: Array<{ value: string; line: number }> = [];
  const pattern = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  for (const match of source.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? '';
    const line = source.slice(0, match.index ?? 0).split('\n').length;
    values.push({ value, line });
  }
  return values;
}

test('ninguna clase Tailwind quedó pegada a la anterior por falta de espacio', () => {
  const findings: Finding[] = [];

  for (const file of SOURCE_DIRS.flatMap((dir) => sourceFiles(dir))) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const { value, line } of classStrings(source)) {
      for (const token of value.split(/\s+/)) {
        if (GLUED_UTILITY.test(token)) findings.push({ file, line, token });
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    `clases sin espacio: ${findings.map((f) => `${f.file}:${f.line} "${f.token}"`).join(', ')}`,
  );
});

test('el CTA principal del checkout pinta fondo de marca y tamaño táctil', () => {
  const source = readFileSync(join(ROOT, 'app/cart/page.tsx'), 'utf8');

  // Fondo de marca + color de contraste en el MISMO className, con espacio real.
  assert.match(
    source,
    /bg-brand text-body-lg font-semibold text-background/,
    'el CTA "Revisar pedido" perdió su fondo de marca o su color de contraste',
  );
  // `flex-1` sobre una columna anula `h-14`: el alto táctil debe venir de min-h.
  assert.match(
    source,
    /min-h-14 flex-1 rounded-xl bg-brand text-body-lg/,
    'el CTA "Revisar pedido" volvió a un alto que colapsa en móvil',
  );
  assert.doesNotMatch(source, /bg-brandtext-/, 'clase concatenada reintroducida');
});

test('los CTAs del detalle de producto y de la confirmación conservan tamaño táctil', () => {
  const product = readFileSync(join(ROOT, 'app/[store]/p/[slug]/StoreProductActions.tsx'), 'utf8');
  const cart = readFileSync(join(ROOT, 'app/cart/page.tsx'), 'utf8');

  assert.match(product, /min-h-14 flex-1 rounded-xl bg-brand px-6 text-body-lg/);
  assert.match(cart, /min-h-12 flex-1 rounded-xl bg-brand font-semibold text-background/);
});
