'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Boxes,
  CreditCard,
  Globe,
  LayoutDashboard,
  Library,
  MessageSquare,
  Monitor,
  Store,
  TrendingUp,
  Wrench,
} from 'lucide-react';
import { useI18n } from '@/components/i18n/I18nProvider';
import { ADMIN_NAV_LINKS, type AdminNavLink } from '@/lib/navigation';

/**
 * Menú del panel.
 *
 * El dueño ve cuatro secciones con ícono; catálogos, inventario, planes y la
 * tablet del kiosco viven en “Herramientas”, plegado. Antes las nueve opciones
 * tenían el mismo peso y el panel parecía el sistema del kiosco.
 */

const ICONS: Record<string, typeof LayoutDashboard> = {
  '/admin': LayoutDashboard,
  '/admin/tiendas': Store,
  '/admin/reclamaciones': MessageSquare,
  '/admin/analytics': TrendingUp,
  '/admin/catalogo': Library,
  '/admin/productos': Globe,
  '/admin/inventario': Boxes,
  '/admin/planes': CreditCard,
  '/admin/kiosco': Monitor,
};

function isActive(pathname: string, href: string): boolean {
  return href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);
}

export function AdminNav() {
  const pathname = usePathname();
  const { t } = useI18n();

  const main = ADMIN_NAV_LINKS.filter((link) => link.group === 'main');
  const tools = ADMIN_NAV_LINKS.filter((link) => link.group === 'tools');

  const renderLink = (link: AdminNavLink, compact: boolean) => {
    const active = isActive(pathname, link.href);
    const Icon = ICONS[link.href] ?? LayoutDashboard;
    return (
      <Link
        key={link.href}
        href={link.href}
        aria-current={active ? 'page' : undefined}
        className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full transition-colors ${
          compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'
        } ${
          active
            ? 'bg-brand font-medium text-background'
            : 'text-tertiary hover:bg-surface-raised hover:text-primary'
        }`}
      >
        <Icon className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} aria-hidden="true" />
        {t(link.labelKey)}
      </Link>
    );
  };

  return (
    <nav aria-label={t('adminNav.aria')} className="-mx-1">
      <ul className="flex items-center gap-1 overflow-x-auto px-1 py-1">
        {main.map((link) => (
          <li key={link.href}>{renderLink(link, false)}</li>
        ))}
      </ul>

      {tools.length > 0 && (
        <details className="mt-1 px-1">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-tertiary hover:bg-surface-raised hover:text-primary">
            <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
            {t('adminNav.tools')}
          </summary>
          <ul className="mt-2 flex flex-wrap items-center gap-1 pb-1">
            {tools.map((link) => (
              <li key={link.href}>{renderLink(link, true)}</li>
            ))}
          </ul>
        </details>
      )}
    </nav>
  );
}
