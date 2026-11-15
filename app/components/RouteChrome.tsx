'use client';

import { usePathname } from 'next/navigation';

/**
 * components/RouteChrome.tsx — decide si el marco público se muestra.
 *
 * La terminal de retiro (`/admin/kiosco`) se usa en una tablet fija, en modo
 * operativo: no lleva encabezado de tienda ("Ingresar", "Carrito") ni footer
 * comercial. Antes los heredaba del layout raíz y ocupaban la primera franja de
 * la pantalla, con enlaces que no tienen nada que ver con entregar un pedido.
 *
 * Las páginas del panel (`/admin/...`) conservan el encabezado: el logo lleva al
 * inicio y no estorba. El footer comercial (tienda / ayuda / legales) no: en un
 * celular empujaba el panel 700 px hacia arriba con enlaces del comprador. El
 * acceso a WhatsApp vive en el bloque "Para negocios" del inicio, no como
 * botón flotante global.
 *
 * Recibe los nodos ya renderizados en el servidor: no importa componentes de
 * servidor dentro de un componente de cliente.
 */
export function RouteChrome({
  header,
  footer,
  banner,
  children,
}: {
  header: React.ReactNode;
  footer: React.ReactNode;
  banner?: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const bare = pathname === '/admin/kiosco' || pathname === '/kiosk';
  const adminArea = pathname?.startsWith('/admin') ?? false;

  return (
    <>
      {bare || adminArea ? null : banner}
      {bare ? null : header}
      {children}
      {bare || adminArea ? null : footer}
    </>
  );
}
