import type { Metadata } from 'next';

/**
 * Todo /admin es privado: nunca se indexa, ni en staging ni en Producción.
 * El layout aplica a todos los paneles (legacy, catálogo, inventario,
 * analytics, planes, kiosco, notas).
 */
export const metadata: Metadata = {
  title: 'Platform Admin',
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
