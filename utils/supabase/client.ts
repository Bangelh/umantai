import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseConfig } from "./env";

const { url: supabaseUrl, key: supabaseKey } = getSupabaseConfig();

export const createClient = () => {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (or the BANGELH_ prefixed variants).",
    );
  }

  return createBrowserClient(supabaseUrl, supabaseKey);
};
