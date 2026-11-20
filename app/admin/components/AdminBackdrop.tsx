'use client';

/**
 * Fondo común del panel de plataforma.
 *
 * Vive en el layout de /admin para que la atmósfera sea la misma en todas las
 * pantallas sin repetir el SVG en cada página. El kiosco queda fuera: es una
 * tablet de mostrador con contraste propio y una luz de fondo ahí solo estorba.
 */
import { usePathname } from 'next/navigation';
import { AuroraBackdrop } from '@/components/ui/AuroraBackdrop';

export function AdminBackdrop() {
  const pathname = usePathname();
  if (pathname.startsWith('/admin/kiosco')) return null;
  return <AuroraBackdrop />;
}
