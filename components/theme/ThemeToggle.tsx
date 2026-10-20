'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useI18n } from '@/components/i18n/I18nProvider';

type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'umantai_theme';
const THEME_COOKIE = 'umantai_theme';

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  const resolved = theme === 'system' ? systemTheme() : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? '#0a0a0a' : '#f7f7f5');
}

/**
 * Alterna claro → oscuro → sistema. La preferencia queda en localStorage y en
 * una cookie legible por el script de arranque, para pintar sin parpadeo.
 * El `<html>` inicial se corrige con `theme-init` antes del primer paint.
 */
export function ThemeToggle({ initialTheme = 'system' }: { initialTheme?: Theme }) {
  const { t } = useI18n();
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Sin persistencia: el tema igual se aplica en esta sesión.
    }
    const maxAge = 60 * 60 * 24 * 365;
    document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${maxAge}; samesite=lax`;
  }, [theme]);

  useEffect(() => {
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => applyTheme('system');
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [theme]);

  const next: Theme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const currentLabel =
    theme === 'light' ? t('theme.light') : theme === 'dark' ? t('theme.dark') : t('theme.system');
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border-strong px-3 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-primary"
      aria-label={`${t('theme.label')}: ${currentLabel}`}
      title={`${t('theme.label')}: ${currentLabel}`}
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
      <span className="hidden sm:inline">{currentLabel}</span>
    </button>
  );
}
