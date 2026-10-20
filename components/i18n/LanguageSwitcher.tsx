'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { LOCALE_COOKIE, LOCALES, resolveLocale, type Locale } from '@/lib/i18n/config';
import { useI18n } from './I18nProvider';

/**
 * Cambia el idioma de la interfaz con una cookie (sin prefijo de ruta) y
 * refresca los Server Components. El contenido de las tiendas no se traduce.
 */
export function LanguageSwitcher() {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const change = (value: string) => {
    const next: Locale = resolveLocale(value);
    const maxAge = 60 * 60 * 24 * 365;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${maxAge}; samesite=lax`;
    startTransition(() => router.refresh());
  };

  return (
    <label className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border-strong px-3 text-xs text-secondary">
      <span className="sr-only">{t('language.label')}</span>
      <select
        value={locale}
        onChange={(event) => change(event.target.value)}
        disabled={pending}
        className="h-8 bg-transparent text-xs text-secondary outline-none disabled:opacity-50"
        aria-label={t('language.label')}
      >
        {LOCALES.map((code) => (
          <option key={code} value={code} className="bg-surface text-primary">
            {code === 'es' ? 'ES' : 'EN'}
          </option>
        ))}
      </select>
    </label>
  );
}
