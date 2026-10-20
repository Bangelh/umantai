/**
 * lib/auth.server.ts — autenticación real (Better Auth + PostgreSQL propio).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ BETTER AUTH Y NO SUPABASE AUTH
 *
 *  Ver AUTH_DECISION.md. Resumen:
 *    · La base de la plataforma es PostgreSQL en Railway. Better Auth guarda
 *      usuarios y sesiones EN ESA MISMA BASE: no hay un segundo proveedor, ni
 *      una segunda fuente de identidad, ni costo externo.
 *    · Sesiones en base + cookie HttpOnly (no JWT legible por JS).
 *    · Email/contraseña ya; OAuth se agrega con un plugin sin cambiar el modelo.
 *    · `store_members` referencia `users.id`: cliente y comerciante son la MISMA
 *      identidad.
 *
 *  MODELO DE DATOS
 *    Las tablas viven en 012_auth.sql y conservan los nombres de columna que
 *    Better Auth espera (`"emailVerified"`, `"userId"`…). Solo se renombran las
 *    tablas mediante `modelName`.
 *
 *  SECRETO
 *    `BETTER_AUTH_SECRET` (o `AUTH_SECRET`) de al menos 32 caracteres. La
 *    instancia es perezosa: `next build` no la construye, así que un build sin
 *    secreto no falla; la primera petición de auth sí falla cerrada (500) hasta
 *    que el entorno esté configurado.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { getDatabaseUrl } from './db';
import {
  buildResetPasswordEmail,
  buildVerifyEmail,
  sendTransactionalEmail,
} from './email.server';
import { isProductionRuntime } from './runtime-environment.server';
import { TenancyError } from './tenancy';

const DEV_SECRET = 'umantai-development-only-secret-change-me';

type BetterAuthInstance = ReturnType<typeof betterAuth>;

let cachedAuth: BetterAuthInstance | null = null;
let cachedPool: Pool | null = null;
let cachedUrl: string | null = null;

function resolveSecret(): string {
  const secret = (process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET ?? '').trim();
  if (secret.length >= 32) return secret;

  if (process.env.NODE_ENV === 'production' && process.env.APP_ENV !== 'staging') {
    throw new Error(
      'auth_secret_missing: define BETTER_AUTH_SECRET (>=32 caracteres) antes de autenticar.',
    );
  }

  // Staging/desarrollo: se permite un secreto efímero para que el deploy no se
  // caiga, pero se avisa una sola vez. NUNCA se usa en Producción.
  if (!secret) {
    console.warn('⚠️  BETTER_AUTH_SECRET no está configurado; usando secreto de desarrollo.');
  }
  return secret || DEV_SECRET;
}

export function resolveAuthBaseUrl(): string {
  const explicit = (
    process.env.BETTER_AUTH_URL ??
    process.env.NEXT_PUBLIC_SERVER_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    ''
  ).trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'development') return 'http://localhost:3000';
  return 'https://umantai.com';
}

/**
 * Verificación obligatoria: en Producción, salvo opt-out explícito. En staging
 * y tests queda desactivada para no bloquear cuentas históricas; el envío del
 * correo y el endpoint de verificación sí se ejercitan (ver tests/E2E).
 */
function requireEmailVerification(): boolean {
  const explicit = (process.env.AUTH_REQUIRE_EMAIL_VERIFICATION ?? '').trim();
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  return isProductionRuntime();
}

function trustedOrigins(baseUrl: string): string[] {
  const origins = new Set<string>([baseUrl, 'http://localhost:3000', 'http://127.0.0.1:3000']);
  for (const value of [
    process.env.RAILWAY_PUBLIC_DOMAIN,
    process.env.NEXT_PUBLIC_SERVER_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
  ]) {
    if (!value) continue;
    origins.add(value.startsWith('http') ? value.replace(/\/+$/, '') : `https://${value.replace(/\/+$/, '')}`);
  }
  return [...origins];
}

export function isAuthConfigured(): boolean {
  return !!getDatabaseUrl();
}

export function getAuthServer(): BetterAuthInstance {
  const url = getDatabaseUrl();
  if (!url) throw new Error('auth_db_not_configured: falta la URL de PostgreSQL.');

  if (cachedAuth && cachedUrl === url) return cachedAuth;

  if (cachedPool && cachedUrl !== url) {
    void cachedPool.end().catch(() => undefined);
    cachedPool = null;
  }

  if (!cachedPool) {
    cachedPool = new Pool({
      connectionString: url,
      max: Number(process.env.PGBETTER_AUTH_POOL_MAX ?? process.env.PGPOOL_MAX ?? 5),
      idleTimeoutMillis: 30_000,
    });
  }
  cachedUrl = url;

  const baseURL = resolveAuthBaseUrl();

  const instance = betterAuth({
    appName: 'UMANTAI',
    baseURL,
    secret: resolveSecret(),
    database: cachedPool,

    user: {
      modelName: 'users',
      fields: {
        emailVerified: 'emailVerified',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    },
    session: {
      modelName: 'sessions',
      fields: {
        expiresAt: 'expiresAt',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
        ipAddress: 'ipAddress',
        userAgent: 'userAgent',
        userId: 'userId',
      },
      // 30 días de vida, refresco como máximo una vez por día y “sesión fresca”
      // de 1 día para operaciones sensibles (cambio de contraseña).
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    account: {
      modelName: 'auth_accounts',
      fields: {
        accountId: 'accountId',
        providerId: 'providerId',
        userId: 'userId',
        accessToken: 'accessToken',
        refreshToken: 'refreshToken',
        idToken: 'idToken',
        accessTokenExpiresAt: 'accessTokenExpiresAt',
        refreshTokenExpiresAt: 'refreshTokenExpiresAt',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    },
    verification: {
      modelName: 'verifications',
      fields: {
        expiresAt: 'expiresAt',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    },

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
      requireEmailVerification: requireEmailVerification(),
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      // Anti-enumeración: la respuesta es la misma exista o no la cuenta.
      // El enlace solo se envía si el usuario existe (Better Auth no llama al
      // callback en caso contrario).
      sendResetPassword: async ({ user, url }) => {
        await sendTransactionalEmail(buildResetPasswordEmail(String(user.email), url));
      },
      onPasswordReset: async () => {
        // El hook existe para que un futuro aviso “tu contraseña cambió” no
        // requiera tocar la configuración. No registra datos personales.
      },
    },

    emailVerification: {
      // Se envía al registrarse aunque la verificación no sea obligatoria, para
      // que el usuario pueda confirmar su correo desde el primer día.
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        await sendTransactionalEmail(buildVerifyEmail(String(user.email), url));
      },
    },

    advanced: {
      // Cookie `Secure` en cualquier despliegue https (staging incluido).
      useSecureCookies: isProductionRuntime() || resolveAuthBaseUrl().startsWith('https://'),
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
    },

    trustedOrigins: trustedOrigins(baseURL),

    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({
            data: {
              ...user,
              email: String(user.email ?? '').trim().toLowerCase(),
              name: String(user.name ?? '').trim() || String(user.email ?? '').split('@')[0],
            },
          }),
        },
      },
    },
  }) as unknown as BetterAuthInstance;

  cachedAuth = instance;
  return instance;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  emailVerified: boolean;
}

function toSessionUser(user: Record<string, unknown>): SessionUser {
  return {
    id: String(user.id),
    name: String(user.name ?? ''),
    email: String(user.email ?? ''),
    image: (user.image as string | null) ?? null,
    emailVerified: user.emailVerified === true,
  };
}

/**
 * Sesión desde los headers de una request (route handler o server component).
 * Devuelve null si no hay cookie válida; NUNCA lanza por sesión ausente.
 */
export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  if (!isAuthConfigured()) return null;
  try {
    const result = await getAuthServer().api.getSession({ headers });
    if (!result?.user) return null;
    return toSessionUser(result.user as unknown as Record<string, unknown>);
  } catch (error) {
    // Un fallo de auth no debe romper una página pública.
    console.error('[auth] no se pudo leer la sesión', error);
    return null;
  }
}

/** Igual que `getSessionUser`, pero exige sesión (401 si falta). */
export async function requireSessionUser(headers: Headers): Promise<SessionUser> {
  const user = await getSessionUser(headers);
  if (!user) {
    throw new TenancyError('not_authenticated', 'Necesitas iniciar sesión.');
  }
  return user;
}

/** Para tests/cierre limpio del pool de auth. */
export async function closeAuthPool(): Promise<void> {
  if (cachedPool) {
    const pool = cachedPool;
    cachedPool = null;
    cachedAuth = null;
    cachedUrl = null;
    await pool.end().catch(() => undefined);
  }
}
