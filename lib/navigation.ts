/**
 * lib/navigation.ts — enlaces de navegación en un solo lugar.
 *
 * Evita que footer, admin y tests mantengan listas distintas de rutas (y que
 * una página legal nueva quede sin enlace). No importa React: se puede testear.
 *
 * `labelKey` es una clave de `lib/i18n/dictionaries.ts`; el texto visible se
 * resuelve con `t()` en el componente que renderiza. Antes esta lista guardaba
 * el texto en español y el footer mostraba «Carrito» en medio de una página en
 * inglés: acá no puede volver a pasar porque el módulo no tiene texto visible.
 */

import type { MessageKey } from './i18n/dictionaries';

export interface NavLink {
  href: string;
  /** Clave i18n del texto visible (nunca texto literal). */
  labelKey: MessageKey;
}

export const SHOP_NAV_LINKS: readonly NavLink[] = [
  // `/products` y `/list` eran del template: `/products` redirige a `/` y la
  // lista de compras no tenía forma de llenarse. Nada en la UI las enlaza.
  { href: '/', labelKey: 'navLink.products' },
  { href: '/cart', labelKey: 'nav.cart' },
  { href: '/kiosk', labelKey: 'navLink.storePickup' },
];

export const LEGAL_NAV_LINKS: readonly NavLink[] = [
  { href: '/legal/privacidad', labelKey: 'legal.privacy' },
  { href: '/legal/terminos', labelKey: 'legal.terms' },
  { href: '/legal/reembolsos', labelKey: 'navLink.refunds' },
  { href: '/legal/cookies', labelKey: 'navLink.cookies' },
  { href: '/legal/aviso-legal', labelKey: 'navLink.legalNotice' },
];

export const HELP_NAV_LINKS: readonly NavLink[] = [
  { href: '/contacto', labelKey: 'navLink.contact' },
  { href: '/libro-de-reclamaciones', labelKey: 'navLink.complaintsBook' },
  { href: '/legal', labelKey: 'navLink.legalDocuments' },
];

export const ADMIN_NAV_LINKS: readonly NavLink[] = [
  { href: '/admin', labelKey: 'adminNav.catalog' },
  { href: '/admin/analytics', labelKey: 'adminNav.analytics' },
  { href: '/admin/inventario', labelKey: 'adminNav.inventory' },
  { href: '/admin/planes', labelKey: 'adminNav.plans' },
  { href: '/admin/reclamaciones', labelKey: 'adminNav.complaints' },
  { href: '/admin/kiosco', labelKey: 'adminNav.kiosk' },
  { href: '/admin/notes', labelKey: 'adminNav.notes' },
];
