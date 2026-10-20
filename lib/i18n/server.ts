/**
 * lib/i18n/server.ts — locale de la request y traductor de servidor.
 */

import { cookies } from 'next/headers';

import { LOCALE_COOKIE, resolveLocale, type Locale } from './config';
import { messagesFor } from './dictionaries';
import { createTranslator, type Translator } from './index';

export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  return resolveLocale(store.get(LOCALE_COOKIE)?.value);
}

export async function getTranslator(): Promise<{ locale: Locale; t: Translator }> {
  const locale = await getLocale();
  return { locale, t: createTranslator(locale) };
}

export function getMessages(locale: Locale) {
  return messagesFor(locale);
}
