import Link from 'next/link';
import { cookies } from 'next/headers';

import { businessConfig } from '@/config/business';
import { HELP_NAV_LINKS, LEGAL_NAV_LINKS, SHOP_NAV_LINKS } from '@/lib/navigation';
import { getTranslator } from '@/lib/i18n/server';
import { Preferences } from '@/components/preferences/Preferences';

/**
 * Footer global. Server Component: no manda JS al cliente salvo el bloque de
 * preferencias (tema/idioma), que sí es interactivo.
 * `print:hidden` evita que aparezca en la lista de compras impresa.
 */
export async function SiteFooter() {
  const { t } = await getTranslator();
  const cookieStore = await cookies();
  const storedTheme = cookieStore.get('umantai_theme')?.value;
  const initialTheme =
    storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system'
      ? storedTheme
      : 'system';

  return (
    <footer className="print:hidden mt-auto border-t border-border bg-surface/40">
      <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-lg font-semibold tracking-tight">{businessConfig.name}</div>
            <p className="mt-2 max-w-xs text-sm leading-relaxed text-tertiary">
              {t('footer.description')}
            </p>
            <div className="mt-4">
              <Preferences initialTheme={initialTheme} />
            </div>
          </div>

          <nav aria-label={t('footer.shop')}>
            <h2 className="text-xs uppercase tracking-wide text-tertiary">{t('footer.shop')}</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {SHOP_NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-secondary hover:text-primary">
                    {t(link.labelKey)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label={t('footer.help')}>
            <h2 className="text-xs uppercase tracking-wide text-tertiary">{t('footer.help')}</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {HELP_NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-secondary hover:text-primary">
                    {t(link.labelKey)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label={t('footer.legal')}>
            <h2 className="text-xs uppercase tracking-wide text-tertiary">{t('footer.legal')}</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {LEGAL_NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-secondary hover:text-primary">
                    {t(link.labelKey)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="mt-8 flex flex-col gap-2 border-t border-border pt-6 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {businessConfig.name}. {t('footer.rights')}
          </p>
          <p>{t('footer.draft')}</p>
        </div>
      </div>
    </footer>
  );
}
