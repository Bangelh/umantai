import { createClient } from '@supabase/supabase-js';
import { isValidHttpUrl } from './config';

// Support custom prefix from Vercel Supabase integration (e.g. BANGELH_)
const prefix = 'BANGELH_';

const supabaseUrl =
  process.env[`${prefix}NEXT_PUBLIC_SUPABASE_URL`] ||
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const supabaseServiceKey =
  process.env[`${prefix}SUPABASE_SERVICE_ROLE_KEY`] ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Cliente con service role, o `null` si Supabase no está configurado.
 *
 * La URL se valida antes de construir el cliente: un placeholder inválido en el
 * entorno NO debe romper el build ni el arranque. Las rutas ya tratan `null`
 * como 503 "Supabase no configurado".
 */
export const supabaseServer = (() => {
  if (!isValidHttpUrl(supabaseUrl) || !supabaseServiceKey) return null;
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      persistSession: false,
    },
  });
})();
