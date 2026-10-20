/**
 * lib/i18n/config.ts — configuración compartida de idioma.
 *
 * El locale vive en una cookie (no en la URL) para no reescribir todas las
 * rutas existentes. Español es el default y el fallback de cualquier clave.
 */

export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'es';
export const LOCALE_COOKIE = 'umantai_locale';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Normaliza `es-PE`, `en-US`, etc. a un locale soportado. */
export function resolveLocale(value: string | null | undefined): Locale {
  if (!value) return DEFAULT_LOCALE;
  const base = value.toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : DEFAULT_LOCALE;
}
