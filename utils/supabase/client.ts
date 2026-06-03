import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseConfig } from "./env";

const { url: supabaseUrl, key: supabaseKey } = getSupabaseConfig();

export const createClient = () =>
  createBrowserClient(
    supabaseUrl!,
    supabaseKey!,
  );
