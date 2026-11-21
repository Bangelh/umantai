/**
 * Portero del panel de una tienda.
 *
 * El chequeo va en el layout, no en la página: `loading.tsx` abre el stream y a
 * partir de ahí el estado HTTP ya no se puede cambiar. Un `notFound()` o
 * `redirect()` lanzado desde la página llega tarde y la respuesta sale como 200
 * (con `noindex`), que es justo lo que no queremos al abrir la tienda de otro.
 */

import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/current-user.server';
import { loadStoreAccess } from '@/lib/store-access.server';

export const dynamic = 'force-dynamic';

interface StorePanelLayoutProps {
  children: ReactNode;
  params: Promise<{ storeId: string }>;
}

export default async function StorePanelLayout({ children, params }: StorePanelLayoutProps) {
  const { storeId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/ingresar?next=/negocio/${storeId}`);

  const access = await loadStoreAccess(user.id, storeId);
  if (!access) notFound();

  return children;
}
