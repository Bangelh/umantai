'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Locale } from '@/lib/i18n/config';
import type { MessageKey } from '@/lib/i18n/dictionaries';

type Vars = Record<string, string | number>;
type ContextValue = {
  locale: Locale;
  t: (key: MessageKey, vars?: Vars) => string;
};

const I18nContext = createContext<ContextValue | null>(null);

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

/**
 * Diccionario del locale activo viene del servidor: no se envían los dos
 * idiomas al cliente. El default (es) ya está completo, así que una clave
 * ausente en `en` cae al texto español antes que mostrar la clave cruda.
 */
export function I18nProvider({
  locale,
  messages,
  fallbackMessages,
  children,
}: {
  locale: Locale;
  messages: Record<string, string>;
  fallbackMessages: Record<string, string>;
  children: ReactNode;
}) {
  const value = useMemo<ContextValue>(
    () => ({
      locale,
      t: (key, vars) =>
        interpolate(messages[key] ?? fallbackMessages[key] ?? key, vars),
    }),
    [locale, messages, fallbackMessages],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): ContextValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error('useI18n debe usarse dentro de I18nProvider');
  }
  return value;
}
