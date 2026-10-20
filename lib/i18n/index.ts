/**
 * lib/i18n/index.ts — traducción pura, usable en servidor y cliente.
 */

import { DEFAULT_LOCALE, type Locale } from './config';
import { MESSAGES, type MessageKey } from './dictionaries';

export type TranslateVars = Record<string, string | number>;

/** Reemplaza `{name}` sin evaluar HTML ni plantillas. */
function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

export function translate(locale: Locale, key: MessageKey, vars?: TranslateVars): string {
  const dictionary = MESSAGES[locale] as Record<string, string>;
  const fallback = MESSAGES[DEFAULT_LOCALE] as Record<string, string>;
  return interpolate(dictionary[key] ?? fallback[key] ?? key, vars);
}

export type Translator = (key: MessageKey, vars?: TranslateVars) => string;

export function createTranslator(locale: Locale): Translator {
  return (key, vars) => translate(locale, key, vars);
}
