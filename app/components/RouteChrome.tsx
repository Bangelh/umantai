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
 * inicio y no estorba. El botón flotante de WhatsApp sí se oculta en todo
 * `/admin` (ver `FloatingWhatsApp`).
 *
 * Recibe los nodos ya renderizados en el servidor: no importa componentes de
 * servidor dentro de un componente de cliente.
 */
export function RouteChrome({
  header,
  footer,
  children,
}: {
  header: React.ReactNode;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const bare = pathname === '/admin/kiosco' || pathname === '/kiosk';

  return (
    <>
      {bare ? null : header}
      {children}
      {bare ? null : footer}
    </>
  );
}
