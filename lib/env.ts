import { z } from 'zod';

/**
 * Environment variable schema with sensible defaults and validation.
 * This provides type safety and clear error messages when variables are missing.
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
const getPrefixedEnv = (key: string): string | undefined => {
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

const envSchema = z.object({
  // ============================================
  // Supabase (base names; prefixed variants are resolved via getPrefixedEnv for BANGELH_/UMANTAI_*)
  // ============================================
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // ============================================
  // WhatsApp
  // ============================================
  NEXT_PUBLIC_WHATSAPP_SALES_PHONE: z.string().min(5).optional(),
  NEXT_PUBLIC_WHATSAPP_SUPPORT_PHONE: z.string().min(5).optional(),
  NEXT_PUBLIC_WHATSAPP_SALES_MESSAGE: z.string().min(1).optional(),
  NEXT_PUBLIC_WHATSAPP_SUPPORT_MESSAGE: z.string().min(1).optional(),

  // ============================================
  // Vercel Postgres
  // ============================================
  POSTGRES_URL: z.string().optional(),
  POSTGRES_URL_NON_POOLING: z.string().optional(),
  POSTGRES_PRISMA_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),

  // ============================================
  // Vercel
  // ============================================
  VERCEL_ENV: z.enum(['production', 'preview', 'development']).default('development'),
  VERCEL_URL: z.string().optional(),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.format());
  throw new Error('Invalid environment variables. Check your .env.local file.');
}

const env = parsedEnv.data;

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

  // Database
  database: {
    // Prefer non-pooling URL for reliability (especially in development)
    url:
      env.POSTGRES_URL_NON_POOLING ||
      env.POSTGRES_URL ||
      env.DATABASE_URL ||
      '',
    prismaUrl: env.POSTGRES_PRISMA_URL || env.POSTGRES_URL || '',
    nonPoolingUrl: env.POSTGRES_URL_NON_POOLING || env.POSTGRES_URL || '',
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
  if (!envConfig.database.url) missing.push('POSTGRES_URL or POSTGRES_URL_NON_POOLING or DATABASE_URL (or BANGELH_/UMANTAI_URL_ prefixed variants)');

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
  return {
    resolvedFrom: found ? found.key : ('none' as const),
    url: found?.val || '',
    isNonPooling: found?.key === 'POSTGRES_URL_NON_POOLING',
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
    isNonPooling: boolean;
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
