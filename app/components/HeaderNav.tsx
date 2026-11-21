'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { useI18n } from '@/components/i18n/I18nProvider';

/**
 * Navegación primaria de escritorio.
 *
 * En móvil la resuelve `MobileBottomNav`; acá solo mostramos las tres rutas que
 * un comprador o comerciante necesita reconocer sin bajar al footer.
 */
export function HeaderNav() {
  const pathname = usePathname();
  const { t } = useI18n();

  // El panel de plataforma tiene su propia navegación; esta es del comprador.
  if (pathname.startsWith('/admin')) return null;

  const links = [
    { href: '/', label: t('navLink.products'), active: pathname === '/' },
    { href: '/vender', label: t('nav.sell'), active: pathname === '/vender' },
    { href: '/contacto', label: t('nav.contact'), active: pathname === '/contacto' },
  ];

  return (
    <div className="hidden items-center gap-1 md:flex">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={link.active ? 'page' : undefined}
          className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
            link.active
              ? 'bg-surface-raised font-semibold text-primary'
              : 'text-secondary hover:bg-surface-raised/60 hover:text-primary'
          }`}
        >
          {link.label}
        </Link>
      ))}
    </div>
  );
}
