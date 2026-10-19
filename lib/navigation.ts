/**
 * lib/navigation.ts — enlaces de navegación en un solo lugar.
 *
 * Evita que footer, admin y tests mantengan listas distintas de rutas (y que
 * una página legal nueva quede sin enlace). No importa React: se puede testear.
 */

export interface NavLink {
  href: string;
  label: string;
}

export const SHOP_NAV_LINKS: readonly NavLink[] = [
  { href: '/products', label: 'Productos' },
  { href: '/list', label: 'Lista de compras' },
  { href: '/cart', label: 'Carrito' },
  { href: '/kiosk', label: 'Retiro en tienda' },
];

export const LEGAL_NAV_LINKS: readonly NavLink[] = [
  { href: '/legal/privacidad', label: 'Privacidad' },
  { href: '/legal/terminos', label: 'Términos' },
  { href: '/legal/reembolsos', label: 'Reembolsos' },
  { href: '/legal/cookies', label: 'Cookies' },
  { href: '/legal/aviso-legal', label: 'Aviso legal' },
];

export const HELP_NAV_LINKS: readonly NavLink[] = [
  { href: '/contacto', label: 'Contacto' },
  { href: '/legal', label: 'Documentos legales' },
];

export const ADMIN_NAV_LINKS: readonly NavLink[] = [
  { href: '/admin', label: 'Catálogo' },
  { href: '/admin/analytics', label: 'Analytics' },
  { href: '/admin/inventario', label: 'Inventario' },
  { href: '/admin/kiosco', label: 'Kiosco' },
  { href: '/admin/notes', label: 'Notas' },
];
