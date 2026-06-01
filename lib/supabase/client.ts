import { createClient } from '@supabase/supabase-js';

// Support custom prefix from Vercel Supabase integration (e.g. BANGELH_)
const prefix = 'BANGELH_';

const supabaseUrl = 
  process.env[`${prefix}NEXT_PUBLIC_SUPABASE_URL`] || 
  process.env.NEXT_PUBLIC_SUPABASE_URL;

const supabaseAnonKey = 
  process.env[`${prefix}NEXT_PUBLIC_SUPABASE_ANON_KEY`] || 
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabaseClient = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;
