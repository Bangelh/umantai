'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/components/i18n/I18nProvider';
import { ADMIN_NAV_LINKS } from '@/lib/navigation';

/** Nav común del panel. Scroll horizontal en móvil; foco visible por token. */
export function AdminNav() {
  const pathname = usePathname();
  const { t } = useI18n();

  return (
    <nav aria-label={t('adminNav.aria')} className="-mx-1 overflow-x-auto">
      <ul className="flex items-center gap-1 px-1 py-1">
        {ADMIN_NAV_LINKS.map((link) => {
          const active = link.href === '/admin' ? pathname === '/admin' : pathname.startsWith(link.href);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex whitespace-nowrap rounded-full px-4 py-2 text-sm transition-colors ${
                  active
                    ? 'bg-brand font-medium text-background'
                    : 'text-tertiary hover:bg-surface-raised hover:text-primary'
                }`}
              >
                {t(link.labelKey)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
