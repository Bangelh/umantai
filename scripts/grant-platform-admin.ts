/**
 * scripts/grant-platform-admin.ts — bootstrap de Platform Admin.
 *
 * Uso:
 *   npm run admin:grant -- correo@dominio.com
 *   npm run admin:grant -- --revoke correo@dominio.com
 *
 * Requiere que la migración 019 esté aplicada y que el usuario exista en
 * Better Auth. No imprime secretos ni contraseñas.
 */

import { createSqlClient } from '../lib/db-driver.server';
import { getDatabaseUrl } from '../lib/db';

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes('--revoke');
  const email = args.filter((arg) => arg !== '--revoke').join(' ').trim().toLowerCase();

  if (!email || !email.includes('@')) {
    console.error('Uso: npm run admin:grant -- [--revoke] correo@dominio.com');
    process.exit(1);
  }

  const url = getDatabaseUrl();
  if (!url) {
    console.error('Falta la URL de PostgreSQL (DATABASE_URL / POSTGRES_URL_NON_POOLING).');
    process.exit(1);
  }

  const sql = createSqlClient(url);

  const users = await sql`SELECT id, email FROM users WHERE lower(email) = ${email} LIMIT 1`;
  const user = users[0];
  if (!user) {
    console.error(`No existe un usuario con correo ${email}. Regístralo primero.`);
    process.exit(1);
  }

  if (revoke) {
    await sql`DELETE FROM platform_admins WHERE user_id = ${String(user.id)}`;
    console.info(`Platform Admin revocado: ${email}`);
    return;
  }

  await sql`
    INSERT INTO platform_admins (user_id)
    VALUES (${String(user.id)})
    ON CONFLICT (user_id) DO NOTHING
  `;
  console.info(`Platform Admin concedido: ${email}`);
}

main().catch((error) => {
  console.error('[admin:grant] falló:', error instanceof Error ? error.message : error);
  process.exit(1);
});
