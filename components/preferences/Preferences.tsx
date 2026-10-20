'use client';

import { LanguageSwitcher } from '@/components/i18n/LanguageSwitcher';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

/** Preferencias globales (tema + idioma) en un solo bloque accesible. */
export function Preferences({
  initialTheme = 'system',
}: {
  initialTheme?: 'light' | 'dark' | 'system';
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ThemeToggle initialTheme={initialTheme} />
      <LanguageSwitcher />
    </div>
  );
}
