/**
 * Environment variable configuration with sensible defaults and validation.
 * This provides type safety and clear error messages when variables are missing.
 * No external deps (e.g. zod) to keep client bundles lean and avoid accidental
 * transitive-only dependency issues after GitHub org migration (OceanSide26 → Bangelh).
 */

// Supported prefixes from Vercel Supabase/Postgres integrations
// Current: BANGELH_* (Bangelh), UMANTAI_URL_* / UMANTAI_* (umantai vercel project e.g. umantai-dh4a-*-umantai.vercel.app)
const VERCEL_ENV_PREFIXES = ['BANGELH_', 'UMANTAI_URL_', 'UMANTAI_'] as const;

/**
 * Get env var value with support for Vercel integration prefixes.
 * Tries (in order):
 *   1. direct key (e.g. NEXT_PUBLIC_SUPABASE_URL)
 *   2. <PREFIX>key (e.g. BANGELH_NEXT_PUBLIC_SUPABASE_URL, UMANTAI_URL_POSTGRES_URL)
 *   3. For NEXT_PUBLIC_* keys: NEXT_PUBLIC_<PREFIX>rest (e.g. NEXT_PUBLIC_UMANTAI_URL_SUPABASE_URL)
 */
export const getPrefixedEnv = (key: string): string | undefined => {
  if (process.env[key]) return process.env[key];

  for (const prefix of VERCEL_ENV_PREFIXES) {
    const withPrefix = process.env[`${prefix}${key}`];
    if (withPrefix) return withPrefix;

    if (key.startsWith('NEXT_PUBLIC_')) {
      const rest = key.slice('NEXT_PUBLIC_'.length);
      const inserted = process.env[`NEXT_PUBLIC_${prefix}${rest}`];
      if (inserted) return inserted;
    }
  }
  return undefined;
};

// Lightweight validation equivalent (avoids zod). Only VERCEL_ENV can cause hard failure here.
const allowedVercelEnvs = ['production', 'preview', 'development'] as const;
let VERCEL_ENV: 'production' | 'preview' | 'development' = 'development';
const rawVercelEnv = process.env.VERCEL_ENV;
if (rawVercelEnv) {
  if ((allowedVercelEnvs as readonly string[]).includes(rawVercelEnv)) {
    VERCEL_ENV = rawVercelEnv as any;
  } else {
    const fakeError = { VERCEL_ENV: { _errors: [`Invalid enum value. Expected 'production' | 'preview' | 'development', received '${rawVercelEnv}'`] } };
    console.error('❌ Invalid environment variables:', fakeError);
    throw new Error('Invalid environment variables. Check your .env.local file.');
  }
}

const env = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  NEXT_PUBLIC_WHATSAPP_SALES_PHONE: process.env.NEXT_PUBLIC_WHATSAPP_SALES_PHONE,
  NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE: process.env.NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE,
  NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE: process.env.NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE,
  NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE: process.env.NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE,
  POSTGRES_URL: process.env.POSTGRES_URL,
  POSTGRES_URL_NON_POOLING: process.env.POSTGRES_URL_NON_POOLING,
  POSTGRES_PRISMA_URL: process.env.POSTGRES_PRISMA_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  VERCEL_ENV,
  VERCEL_URL: process.env.VERCEL_URL,
};

// Export a clean, typed object with sensible naming and fallbacks
export const envConfig = {
  // Supabase - supports BANGELH_/UMANTAI_URL_* prefixes from Vercel integrations
  supabase: {
    url:
      getPrefixedEnv('NEXT_PUBLIC_SUPABASE_URL') ||
      env.NEXT_PUBLIC_SUPABASE_URL ||
      '',
    anonKey:
      getPrefixedEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY') ||
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      '',
    serviceRoleKey:
      getPrefixedEnv('SUPABASE_SERVICE_ROLE_KEY') ||
      env.SUPABASE_SERVICE_ROLE_KEY ||
      '',
  },

  // WhatsApp Floating Button
  whatsapp: {
    salesPhone: env.NEXT_PUBLIC_WHATSAPP_SALES_PHONE || '',
    supportPhone: env.NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE || '',
    salesMessage:
      env.NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE ||
      "Hello! I'd like to know more about your products.",
    supportMessage:
      env.NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE ||
      'Hello! I need help with my order or account.',
  },

  // Database (Postgres via Neon serverless driver or compatible; supports Vercel/Neon injected vars)
  database: {
    // Prefer non-pooling URL for reliability (especially in development)
    // Uses getPrefixedEnv so BANGELH_/UMANTAI_URL_* etc from Vercel integrations are picked up
    url:
      getPrefixedEnv('POSTGRES_URL_NON_POOLING') ||
      getPrefixedEnv('POSTGRES_URL') ||
      getPrefixedEnv('DATABASE_URL') ||
      '',
    prismaUrl:
      getPrefixedEnv('POSTGRES_PRISMA_URL') ||
      getPrefixedEnv('POSTGRES_URL') ||
      '',
    nonPoolingUrl:
      getPrefixedEnv('POSTGRES_URL_NON_POOLING') ||
      getPrefixedEnv('POSTGRES_URL') ||
      '',
  },

  // Vercel runtime info
  vercel: {
    env: env.VERCEL_ENV,
    url: env.VERCEL_URL || 'http://localhost:3000',
    isProduction: env.VERCEL_ENV === 'production',
    isPreview: env.VERCEL_ENV === 'preview',
    isDevelopment: env.VERCEL_ENV === 'development',
  },
} as const;

// Type export for consumers
export type EnvConfig = typeof envConfig;

// === Environment Validation & Startup Logging ===

function validateEnvironment() {
  const isProd = envConfig.vercel.isProduction;
  const missing: string[] = [];

  // Critical for most functionality
  if (!envConfig.supabase.url) missing.push('NEXT_PUBLIC_SUPABASE_URL (or BANGELH_/UMANTAI_URL_/NEXT_PUBLIC_UMANTAI_URL_ variants)');
  if (!envConfig.supabase.anonKey) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY (or BANGELH_/UMANTAI_URL_/NEXT_PUBLIC_UMANTAI_URL_ variants)');
  if (!envConfig.database.url) missing.push('POSTGRES_URL or POSTGRES_URL_NON_POOLING or DATABASE_URL (or BANGELH_/UMANTAI_URL_ prefixed variants) — prefer the DIRECT/non-pooled string for POSTGRES_URL_NON_POOLING');

  // Critical for admin + notes features
  if (!envConfig.supabase.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY (or BANGELH_/UMANTAI_URL_ variants)');

  if (missing.length > 0) {
    const message = `Missing critical environment variables:\n- ${missing.join('\n- ')}`;

    if (isProd) {
      console.error('❌ ' + message);
      throw new Error('Application cannot start in production with missing environment variables. ' + message);
    } else {
      console.warn('⚠️  ' + message);
      console.warn('   Some features (especially admin + notes) may not work correctly.');
    }
  } else {
    console.log('✅ Environment variables validated successfully');
    console.log(`   Environment: ${envConfig.vercel.env}`);
    console.log(`   Supabase: ${envConfig.supabase.url ? 'Connected' : 'Not configured'} (prefix support: BANGELH_/UMANTAI_URL_*)`);
    console.log(`   Database: ${envConfig.database.url ? 'Connected' : 'Not configured'}`);
    console.log(`   WhatsApp: ${envConfig.whatsapp.salesPhone ? 'Configured' : 'Not configured'}`);

    // Warn if using a pooled connection string (common source of "fetch failed" / connectivity issues in dev)
    // Only warn in development to avoid noisy build logs on Vercel production deploys.
    // For production, ensure you set the non-pooled DIRECT connection string in Vercel env vars.
    const dbUrl = envConfig.database.url || '';
    const isPooled = /pooler|pooler\.supabase/i.test(dbUrl);
    if (process.env.NODE_ENV === 'development' && dbUrl && isPooled) {
      console.warn('⚠️  Database URL appears to be a pooled connection (contains "pooler").');
      console.warn('   For local development and Neon serverless driver reliability, use the DIRECT (non-pooled) connection string.');
      console.warn('   Update POSTGRES_URL_NON_POOLING (and UMANTAI_URL_POSTGRES_URL_NON_POOLING if using prefixed) in .env.local');
      console.warn('   Get it from Supabase Dashboard → Database → Connect → "Direct connection" (NOT the pooled one).');
      console.warn('   Even if you set it under the NON_POOLING var name, the value must be the direct string.');
    }
    if (isPooled) {
      // Also surface in the debug info
      (envConfig as any).database.isPooled = true;
    }
  }
}

// Run validation on server startup
if (typeof window === 'undefined') {
  validateEnvironment();
}

// ============================================
// DEBUG UTILITIES (server-only, secrets masked)
// ============================================

function maskValue(val: string | undefined, visible = 4): string {
  if (!val) return '(empty)';
  if (val.length <= visible * 2 + 2) return '***';
  return val.slice(0, visible) + '⋯' + val.slice(-visible);
}

function maskDatabaseUrl(raw: string): string {
  if (!raw) return '(none)';
  try {
    if (raw.startsWith('postgres')) {
      const atIdx = raw.indexOf('@');
      if (atIdx > 0) {
        const schemeEnd = raw.indexOf('://') + 3;
        const scheme = raw.slice(0, schemeEnd);
        const afterAt = raw.slice(atIdx + 1);
        const slashIdx = afterAt.indexOf('/');
        const hostPart = slashIdx >= 0 ? afterAt.slice(0, slashIdx) : afterAt;
        const pathPart = slashIdx >= 0 ? afterAt.slice(slashIdx) : '';
        const maskedHost = hostPart.length > 20
          ? hostPart.slice(0, 8) + '…' + hostPart.slice(-8)
          : hostPart;
        return `${scheme}***:***@${maskedHost}${pathPart}`;
      }
    }
    if (raw.startsWith('http')) {
      const u = new URL(raw);
      const h = u.hostname;
      const maskedHost = h.length > 18 ? h.slice(0, 7) + '…' + h.slice(-7) : h;
      return `${u.protocol}//${maskedHost}${u.pathname}${u.search ? '?...' : ''}`;
    }
  } catch {
    // fallthrough
  }
  return raw.length > 28 ? raw.slice(0, 12) + '…' + raw.slice(-10) : '***';
}

function resolveDatabaseSource() {
  const candidates = [
    { key: 'POSTGRES_URL_NON_POOLING' as const, val: getPrefixedEnv('POSTGRES_URL_NON_POOLING') },
    { key: 'POSTGRES_URL' as const, val: getPrefixedEnv('POSTGRES_URL') },
    { key: 'DATABASE_URL' as const, val: getPrefixedEnv('DATABASE_URL') },
    { key: 'POSTGRES_PRISMA_URL' as const, val: getPrefixedEnv('POSTGRES_PRISMA_URL') },
  ];
  const found = candidates.find((c) => !!c.val);
  const url = found?.val || '';
  const isPooledValue = /pooler|pooler\.supabase/i.test(url);
  const intendedNonPooling = found?.key === 'POSTGRES_URL_NON_POOLING';
  return {
    resolvedFrom: found ? found.key : ('none' as const),
    url,
    isNonPooling: intendedNonPooling, // picked the *named* non-pooling var (may still have pooled *value*)
    isPooled: isPooledValue,
    effectiveIsNonPooling: intendedNonPooling && !isPooledValue,
  };
}

export interface EnvDebugInfo {
  timestamp: string;
  runtime: {
    nodeVersion: string;
    platform: string;
    vercel: boolean;
  };
  vercel: {
    env: string;
    url: string;
    isProduction: boolean;
    isPreview: boolean;
    isDevelopment: boolean;
    VERCEL?: string;
    VERCEL_REGION?: string;
    VERCEL_GIT_COMMIT_SHA?: string;
    VERCEL_GIT_COMMIT_REF?: string;
    VERCEL_GIT_COMMIT_MESSAGE?: string;
    VERCEL_GIT_REPO_SLUG?: string;
    VERCEL_GIT_REPO_OWNER?: string;
  };
  database: {
    configured: boolean;
    resolvedFrom: 'POSTGRES_URL_NON_POOLING' | 'POSTGRES_URL' | 'DATABASE_URL' | 'POSTGRES_PRISMA_URL' | 'none';
    isNonPooling: boolean; // resolved from the NON_POOLING *var name* (may still be a pooled *value*)
    isPooled: boolean; // ALWAYS derived from actual URL value containing "pooler" (hostname or string)
    effectiveIsNonPooling: boolean; // true only if resolved from NON_POOLING var AND the value is NOT pooled
    urlMasked: string;
    urlLength: number;
  };
  supabase: {
    urlConfigured: boolean;
    urlMasked: string;
    anonKeyConfigured: boolean;
    anonKeyMasked: string;
    serviceRoleConfigured: boolean;
    serviceRoleMasked: string;
  };
  whatsapp: {
    salesConfigured: boolean;
    supportConfigured: boolean;
  };
  presence: Record<string, boolean>;
  note: string;
}

export function getEnvDebugInfo(): EnvDebugInfo {
  const dbRes = resolveDatabaseSource();
  const dbMasked = maskDatabaseUrl(dbRes.url);

  let supabaseMaskedUrl = '';
  if (envConfig.supabase.url) {
    try {
      const u = new URL(envConfig.supabase.url);
      const h = u.hostname;
      const masked = h.length > 14 ? h.slice(0, 5) + '…' + h.slice(-8) : h;
      supabaseMaskedUrl = `${u.protocol}//${masked}`;
    } catch {
      supabaseMaskedUrl = envConfig.supabase.url.slice(0, 18) + '…';
    }
  }

  const vercelSystem = {
    VERCEL: process.env.VERCEL || undefined,
    VERCEL_REGION: process.env.VERCEL_REGION || undefined,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
    VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF || undefined,
    VERCEL_GIT_COMMIT_MESSAGE: process.env.VERCEL_GIT_COMMIT_MESSAGE ? process.env.VERCEL_GIT_COMMIT_MESSAGE.slice(0, 110) : undefined,
    VERCEL_GIT_REPO_SLUG: process.env.VERCEL_GIT_REPO_SLUG || undefined,
    VERCEL_GIT_REPO_OWNER: process.env.VERCEL_GIT_REPO_OWNER || undefined,
  };

  const presence: Record<string, boolean> = {
    'NEXT_PUBLIC_SUPABASE_URL (or BANGELH_/UMANTAI_URL_*)': !!envConfig.supabase.url,
    'NEXT_PUBLIC_SUPABASE_ANON_KEY (or BANGELH_/UMANTAI_URL_*)': !!envConfig.supabase.anonKey,
    'SUPABASE_SERVICE_ROLE_KEY (or BANGELH_/UMANTAI_URL_*)': !!envConfig.supabase.serviceRoleKey,
    'POSTGRES_URL* / DATABASE_URL (prefixed ok)': !!envConfig.database.url,
    'POSTGRES_URL_NON_POOLING (direct or prefixed)': !!getPrefixedEnv('POSTGRES_URL_NON_POOLING'),
    'NEXT_PUBLIC_WHATSAPP_SALES_PHONE': !!envConfig.whatsapp.salesPhone,
    'NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE': !!envConfig.whatsapp.supportPhone,
  };

  return {
    timestamp: new Date().toISOString(),
    runtime: {
      nodeVersion: typeof process !== 'undefined' ? process.version : 'n/a',
      platform: typeof process !== 'undefined' ? process.platform : 'n/a',
      vercel: !!process.env.VERCEL,
    },
    vercel: {
      ...envConfig.vercel,
      ...vercelSystem,
    },
    database: {
      configured: !!envConfig.database.url,
      resolvedFrom: dbRes.resolvedFrom,
      isNonPooling: dbRes.isNonPooling,
      isPooled: dbRes.isPooled,
      effectiveIsNonPooling: dbRes.effectiveIsNonPooling,
      urlMasked: dbMasked,
      urlLength: dbRes.url ? dbRes.url.length : 0,
    },
    supabase: {
      urlConfigured: !!envConfig.supabase.url,
      urlMasked: supabaseMaskedUrl,
      anonKeyConfigured: !!envConfig.supabase.anonKey,
      anonKeyMasked: envConfig.supabase.anonKey ? maskValue(envConfig.supabase.anonKey, 6) : '(empty)',
      serviceRoleConfigured: !!envConfig.supabase.serviceRoleKey,
      serviceRoleMasked: envConfig.supabase.serviceRoleKey ? maskValue(envConfig.supabase.serviceRoleKey, 4) : '(empty)',
    },
    whatsapp: {
      salesConfigured: !!envConfig.whatsapp.salesPhone,
      supportConfigured: !!envConfig.whatsapp.supportPhone,
    },
    presence,
    note: 'All secret values are masked. This data is for diagnostics only.',
  };
}

export default envConfig;
