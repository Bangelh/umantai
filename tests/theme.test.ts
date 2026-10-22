/**
 * tests/theme.test.ts — contrato de tema claro/oscuro/sistema.
 *
 * Auditoría local, sin navegador: los tokens deben existir en ambos temas, el
 * script de arranque debe resolver `system` antes del primer paint y el toggle
 * debe persistir la preferencia en cookie + localStorage y escuchar cambios del
 * sistema. Un token nuevo sin valor claro se detecta acá, no en QA visual.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const CSS = readFileSync(join(root, 'app/globals.css'), 'utf8');
const LAYOUT = readFileSync(join(root, 'app/layout.tsx'), 'utf8');
const TOGGLE = readFileSync(join(root, 'components/theme/ThemeToggle.tsx'), 'utf8');

function block(source: string, selector: string): string {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `falta el bloque ${selector}`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('\n}', open);
  return source.slice(open, close);
}

function tokens(source: string): Set<string> {
  return new Set([...source.matchAll(/(--um-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
}

test('cada token del tema oscuro tiene valor en el tema claro', () => {
  const dark = tokens(block(CSS, ':root {'));
  const light = tokens(block(CSS, '[data-theme="light"] {'));

  assert.ok(dark.size > 15, `se esperaban tokens, se leyeron ${dark.size}`);
  assert.deepEqual([...light].sort(), [...dark].sort());
});

test('los estados y la elevación se redefinen en claro para mantener contraste', () => {
  const light = block(CSS, '[data-theme="light"] {');
  for (const token of [
    '--um-success',
    '--um-warning',
    '--um-destructive',
    '--um-info',
    '--um-shadow-card',
    '--um-border',
    '--um-brand',
  ]) {
    assert.match(light, new RegExp(`${token}\\s*:`), `falta ${token} en claro`);
  }
  assert.match(light, /color-scheme:\s*light/);
  assert.match(block(CSS, ':root {'), /color-scheme:\s*dark/);
});

test('el script de arranque resuelve light/dark/system antes del paint', () => {
  const match = LAYOUT.match(/const THEME_INIT_SCRIPT = `([^`]+)`;/);
  assert.ok(match, 'no se encontró THEME_INIT_SCRIPT');
  const script = match[1];

  assert.match(script, /prefers-color-scheme:\s*dark/, 'no consulta el tema del sistema');
  assert.match(script, /'system'/);
  assert.match(script, /documentElement\.dataset\.theme/);
  assert.match(script, /documentElement\.style\.colorScheme/);
  assert.match(script, /resolved='dark'/, 'no falla a un tema válido');
  assert.match(LAYOUT, /data-theme=\{initialTheme\}/);
  assert.match(LAYOUT, /suppressHydrationWarning/);
});

test('el toggle persiste en cookie y localStorage y escucha al sistema', () => {
  assert.match(TOGGLE, /localStorage\.setItem\(THEME_KEY, theme\)/);
  assert.match(TOGGLE, /document\.cookie = `\$\{THEME_COOKIE\}/);
  assert.match(TOGGLE, /matchMedia\('\(prefers-color-scheme: dark\)'\)/);
  assert.match(TOGGLE, /media\.addEventListener\('change', listener\)/);
  assert.match(TOGGLE, /media\.removeEventListener\('change', listener\)/);
  // Ciclo claro → oscuro → sistema → claro.
  assert.match(TOGGLE, /theme === 'light' \? 'dark' : theme === 'dark' \? 'system' : 'light'/);
  // Etiqueta accesible, no solo un icono.
  assert.match(TOGGLE, /aria-label=\{`\$\{t\('theme\.label'\)\}/);
});

test('la cookie de tema del servidor solo admite light/dark y cae a oscuro', () => {
  assert.match(LAYOUT, /preferredTheme === 'light' \|\| preferredTheme === 'dark'/);
  assert.match(LAYOUT, /\? preferredTheme\s*:\s*'dark'/);
});
