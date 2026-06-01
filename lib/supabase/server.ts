import { createClient } from '@supabase/supabase-js';

// Support custom prefix from Vercel Supabase integration (e.g. BANGELH_)
const prefix = 'BANGELH_';

const supabaseUrl = 
  process.env[`${prefix}NEXT_PUBLIC_SUPABASE_URL`] || 
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const supabaseServiceKey = 
  process.env[`${prefix}SUPABASE_SERVICE_ROLE_KEY`] || 
  process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabaseServer = (supabaseUrl && supabaseServiceKey)
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
      },
    })
  : null;
