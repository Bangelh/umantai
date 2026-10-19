import { createClient } from '@supabase/supabase-js';
import { isValidHttpUrl } from './config';

// Support custom prefix from Vercel Supabase integration (e.g. BANGELH_)
const prefix = 'BANGELH_';

const supabaseUrl =
  process.env[`${prefix}NEXT_PUBLIC_SUPABASE_URL`] ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const supabaseAnonKey =
  process.env[`${prefix}NEXT_PUBLIC_SUPABASE_ANON_KEY`] ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Cliente anónimo de navegador, o `null` si Supabase no está configurado.
 * Igual que el server: nunca se construye con una URL inválida.
 */
export const supabaseClient = (() => {
  if (!isValidHttpUrl(supabaseUrl) || !supabaseAnonKey) return null;
  return createClient(supabaseUrl, supabaseAnonKey);
})();
