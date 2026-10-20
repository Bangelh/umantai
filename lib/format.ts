/**
 * lib/format.ts — formato centralizado de moneda, fechas, horas, números y
 * distancia.
 *
 * Regla: la UI NUNCA llama `toFixed`, `toLocaleString` ni `Intl.*` por su
 * cuenta. Todo pasa por acá para que es/en compartan criterio y para que un
 * cambio de zona horaria o de moneda se haga en un solo lugar.
 *
 * El contenido creado por comerciantes (nombres, descripciones, direcciones)
 * no se formatea ni se traduce: se muestra tal cual.
 */

import type { Locale } from './i18n/config';

export const DEFAULT_CURRENCY = 'PEN';
export const DEFAULT_TIME_ZONE = 'America/Lima';

const CURRENCY_SYMBOLS: Record<string, string> = { PEN: 'S/', USD: '$', EUR: '€' };
const INTL_LOCALE: Record<Locale, string> = { es: 'es-PE', en: 'en-US' };

export function intlLocale(locale: Locale): string {
  return INTL_LOCALE[locale] ?? INTL_LOCALE.es;
}

/**
 * Dinero en centavos enteros. `S/ 12,50` en español y `S/ 12.50` en inglés.
 * Se usa un separador manual (no Intl.NumberFormat) para que el símbolo quede
 * pegado al monto y el resultado sea estable entre Node y el navegador.
 */
export function formatMoney(
  cents: number,
  currency: string = DEFAULT_CURRENCY,
  locale: Locale = 'es',
): string {
  const safe = Number.isFinite(cents) ? Math.max(0, Math.round(cents)) : 0;
  const amount = (safe / 100).toFixed(2);
  const localized = locale === 'es' ? amount.replace('.', ',') : amount;
  const code = (currency || DEFAULT_CURRENCY).toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol} ${localized}` : `${code} ${localized}`;
}

/** Dinero en unidades (no centavos), para inputs y resúmenes de checkout. */
export function formatMoneyUnits(
  value: number,
  currency: string = DEFAULT_CURRENCY,
  locale: Locale = 'es',
): string {
  return formatMoney(Math.round((Number.isFinite(value) ? value : 0) * 100), currency, locale);
}

/** Número entero/decimal con separadores del locale. */
export function formatNumber(value: number, locale: Locale = 'es', options?: Intl.NumberFormatOptions): string {
  const safe = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat(intlLocale(locale), options).format(safe);
}

/** Porcentaje ya expresado en 0..100 (redondea a un decimal como máximo). */
export function formatPercent(value: number, locale: Locale = 'es'): string {
  const safe = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(safe / 100);
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Fecha (sin hora). `dateStyle` medium por defecto. */
export function formatDate(
  value: string | number | Date | null | undefined,
  locale: Locale = 'es',
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const date = toDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: DEFAULT_TIME_ZONE,
    ...options,
  }).format(date);
}

/** Fecha + hora. */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  locale: Locale = 'es',
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return formatDate(value, locale, options);
}

/** Hora sola (reloj local del negocio). */
export function formatTime(
  value: string | number | Date | null | undefined,
  locale: Locale = 'es',
): string {
  return formatDate(value, locale, { timeStyle: 'short' });
}

/**
 * Distancia compacta para listas densas: "400 m", "3,2 km", "12 km".
 * En inglés usa punto decimal.
 */
export function formatDistance(
  distanceKm: number | null | undefined,
  locale: Locale = 'es',
): string {
  if (distanceKm === null || distanceKm === undefined || !Number.isFinite(distanceKm)) return '';
  const decimal = (value: number) => (locale === 'es' ? value.toFixed(1).replace('.', ',') : value.toFixed(1));
  if (distanceKm < 1) return `${Math.max(10, Math.round((distanceKm * 1000) / 10) * 10)} m`;
  if (distanceKm < 10) return `${decimal(distanceKm)} km`;
  return `${Math.round(distanceKm)} km`;
}

/** Coordenadas legibles cuando no hay una zona conocida cerca. */
export function formatCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}
