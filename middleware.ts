import { type NextRequest } from 'next/server'
import { updateSession } from '@/utils/supabase/middleware'

/**
 * Next.js middleware for Supabase auth session handling.
 * 
 * Note: Next.js may warn about "middleware" file convention being deprecated in favor of "proxy".
 * For standard auth middleware + Supabase, keeping the file as `middleware.ts` is still the
 * recommended and supported approach for most apps. The "proxy" convention is experimental/new
 * for specific edge proxy use cases. See: https://nextjs.org/docs/messages/middleware-to-proxy
 */
export async function middleware(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder assets (images, etc.)
     * Feel free to modify this pattern to include more paths.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
