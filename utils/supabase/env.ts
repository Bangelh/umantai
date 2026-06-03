/**
 * Supabase environment config helper.
 * Replicates the prefix resolution from lib/env.ts but in a minimal, Edge-runtime-safe file.
 * This avoids importing the full lib/env (which references Node-only APIs like process.platform
 * in debug functions, causing Turbopack Edge build errors when pulled into middleware).
 *
 * Supports the project's Vercel integration prefixes (BANGELH_, UMANTAI_URL_, UMANTAI_).
 */

const VERCEL_ENV_PREFIXES = ['BANGELH_', 'UMANTAI_URL_', 'UMANTAI_'] as const;

/**
 * Get env var value with support for Vercel integration prefixes.
 * Same logic as in lib/env.ts.
 */
function getPrefixedEnv(key: string): string | undefined {
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
}

export function getSupabaseConfig() {
  const url =
    getPrefixedEnv('NEXT_PUBLIC_SUPABASE_URL') ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    '';

  // Support both legacy ANON_KEY and newer PUBLISHABLE_KEY naming
  const key =
    getPrefixedEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY') ||
    getPrefixedEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY') ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    '';

  return { url, key };
}
