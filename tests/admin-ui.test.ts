/**
 * tests/admin-ui.test.ts — Platform Admin sin token manual en la UI.
 *
 * Contrato de producto y de seguridad: ningún componente del navegador pide,
 * guarda ni envía `ADMIN_API_SECRET`. La sesión viaja en una cookie HttpOnly
 * firmada, emitida por `/api/admin/session` después de validar la cuenta real.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const UI_FILES = [...walk(join(root, 'app')), ...walk(join(root, 'components'))];

test('ningún componente del navegador usa el token compartido', () => {
  const offenders: string[] = [];
  for (const file of UI_FILES) {
    const source = readFileSync(file, 'utf8');
    if (/\bADMIN_API_SECRET\b|x-admin-token|umantai-admin-token|getAdminToken\(/.test(source)) {
      offenders.push(relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('la pantalla de acceso no tiene campo de token', () => {
  const screen = readFileSync(join(root, 'components/admin/AdminAccessScreen.tsx'), 'utf8');
  assert.doesNotMatch(screen, /<input/);
  assert.match(screen, /usePathname/);
  assert.match(screen, /admin\.activate/);
});

test('la cookie de Platform Admin es HttpOnly, SameSite=Strict y expira', () => {
  const route = readFileSync(join(root, 'app/api/admin/session/route.ts'), 'utf8');
  assert.match(route, /name: PLATFORM_ADMIN_COOKIE/);
  assert.match(route, /httpOnly: true/);
  assert.match(route, /sameSite: 'strict'/);
  assert.match(route, /secure: process\.env\.NODE_ENV === 'production'/);
  assert.match(route, /maxAge: PLATFORM_ADMIN_TTL_SECONDS/);
  assert.match(route, /maxAge: 0/);
});

test('los paneles usan la sesión, no un estado de token en localStorage', () => {
  const pages = UI_FILES.filter(
    (file) => file.includes(`${join('app', 'admin')}`) && file.endsWith('page.tsx'),
  );
  assert.ok(pages.length >= 5, `se esperaban paneles, se encontraron ${pages.length}`);

  const withoutSession = pages.filter((file) => {
    const source = readFileSync(file, 'utf8');
    return source.includes('AdminAccessScreen') && !source.includes('usePlatformAdminSession');
  });
  assert.deepEqual(withoutSession.map((file) => relative(root, file)), []);
});
