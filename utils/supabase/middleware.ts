import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { getSupabaseConfig } from "./env";

const { url: supabaseUrl, key: supabaseKey } = getSupabaseConfig();

export const updateSession = async (request: NextRequest) => {
  // Create an unmodified response
  let supabaseResponse = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  if (!supabaseUrl || !supabaseKey) {
    // Graceful fallback: don't break the entire site if Supabase env is not configured
    // (e.g. during initial setup or misconfigured Vercel envs)
    console.warn('[Supabase Middleware] NEXT_PUBLIC_SUPABASE_URL or key missing — skipping session refresh. Middleware will pass through.');
    return supabaseResponse;
  }

  const supabase = createServerClient(
    supabaseUrl,
    supabaseKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    },
  );

  try {
    // IMPORTANT: This call refreshes the session cookie if needed.
    // It must be awaited to keep user sessions alive across requests.
    await supabase.auth.getUser();
  } catch (err) {
    // Never let Supabase auth errors crash the middleware / site
    console.error('[Supabase Middleware] getUser() failed (non-fatal):', err);
  }

  // Optional: add custom logic here, e.g. protected routes
  // if (!user && request.nextUrl.pathname.startsWith('/protected')) { ... }

  return supabaseResponse;
};
