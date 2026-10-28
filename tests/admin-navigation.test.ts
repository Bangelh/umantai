/**
 * tests/admin-navigation.test.ts — el panel se navega como un operador real.
 *
 * Contrato mínimo:
 *   · El menú incluye la aprobación de tiendas y el catálogo maestro, que existían
 *     como API/página pero no se podían alcanzar desde la UI.
 *   · Ya no incluye la demo de notas (no es producto).
 *   · `/admin` dejó de ser el editor legacy del template: no muestra precios en
 *     dólares ni "Backend Management".
 *   · `/kiosk` dejó de ser una demo falsa y el cliente ya no la enlaza.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ADMIN_NAV_LINKS, SHOP_NAV_LINKS } from '../lib/navigation';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('el menú de admin incluye tiendas y catálogo maestro', () => {
  const hrefs = ADMIN_NAV_LINKS.map((link) => link.href);
  assert.ok(hrefs.includes('/admin/tiendas'), 'falta la aprobación de tiendas');
  assert.ok(hrefs.includes('/admin/catalogo'), 'falta el catálogo maestro');
  assert.equal(hrefs[0], '/admin', 'el panel debe ser la primera entrada');
});

test('la demo de notas no está en el menú', () => {
  assert.ok(!ADMIN_NAV_LINKS.some((link) => link.href === '/admin/notes'));
});

test('/admin ya no es el editor legacy del catálogo', () => {
  const page = read('app/admin/page.tsx');
  // Se busca en el código, no en los comentarios que explican qué había antes.
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /Vercel Postgres/);
  assert.doesNotMatch(code, /Backend Management/);
  assert.doesNotMatch(code, /baseProducts/);
  assert.match(code, /\/api\/admin\/stores/);
});

test('el editor legacy vive en /admin/productos y se identifica como tal', () => {
  const page = read('app/admin/productos/page.tsx');
  assert.match(page, /Catálogo del sitio/);
  assert.match(page, /catálogo base del sitio/);
});

test('el cliente no enlaza /kiosk', () => {
  assert.ok(!SHOP_NAV_LINKS.some((link) => link.href === '/kiosk'));
  assert.doesNotMatch(read('app/components/MobileBottomNav.tsx'), /href: "\/kiosk"/);
  assert.doesNotMatch(read('app/components/NavActions.tsx'), /href="\/kiosk"/);
});

test('/kiosk redirige en vez de mostrar la demo falsa', () => {
  const page = read('app/kiosk/page.tsx');
  assert.match(page, /redirect\('\/'\)/);
  // Ya no es un componente interactivo con pedidos inventados.
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /useState|UM-48291|Camera active/i);
});
