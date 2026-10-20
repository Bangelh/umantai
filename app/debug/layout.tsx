import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { getPlatformAdminSession } from '@/lib/platform-admin.server';

/**
 * /debug queda fuera del sitio público.
 *
 * Antes estas páginas se abrían con el token compartido (o directamente, como
 * `/debug/supabase`). Ahora la única puerta es la cookie firmada de Platform
 * Admin: sin ella la ruta responde 404 y no revela que existe.
 */
export const dynamic = 'force-dynamic';

export default async function DebugLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const request = new Request('http://localhost/debug', { headers: requestHeaders });
  if (!getPlatformAdminSession(request)) notFound();
  return children;
}
