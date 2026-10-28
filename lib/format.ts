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
 * ── CONTRATO MONETARIO DE UMANTAI ───────────────────────────────────────────
 *
 * Hay EXACTAMENTE dos representaciones y una sola frontera entre ellas:
 *
 *   1. CENTAVOS (`*_cents`)  · entero, unidad canónica de PERSISTENCIA.
 *      `store_products.price_cents`, `store_product_variants.price_cents`,
 *      `complaints.amount_cents`, analytics. Nunca un float.
 *
 *   2. UNIDADES (`unitPrice`, `total`) · decimal con 2 decimales, unidad del
 *      DOMINIO DE PEDIDOS y del carrito. `orders.unit_price`, `orders.total`,
 *      `order_items.line_total` (NUMERIC(10,2) con CHECK de cuadre).
 *
 * La conversión SOLO ocurre en el borde, con `centsToUnits` / `unitsToCents`
 * (o `formatMoney` / `formatMoneyUnits` cuando además se va a mostrar).
 * PROHIBIDO escribir `/ 100` o `* 100` sueltos sobre un precio en la UI o en
 * un componente: si aparece uno, es un bug esperando a ocurrir (fue justo el
 * origen del carrito que mostraba S/ 1200,00).
 *
 * `Product.price` (carrito) está en UNIDADES. `priceCents` (catálogo, API)
 * está en CENTAVOS. Un componente que mezcla ambos campos tiene que convertir
 * explícitamente al armar la línea del carrito.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Centavos enteros → unidades decimales. Redondea a 2 decimales. */
export function centsToUnits(cents: number): number {
  const safe = Number.isFinite(cents) ? Math.round(cents) : 0;
  return safe / 100;
}

/** Unidades decimales → centavos enteros. Redondea al centavo más cercano. */
export function unitsToCents(units: number): number {
  const safe = Number.isFinite(units) ? units : 0;
  return Math.round(safe * 100);
}

/**
 * Texto de un input de precio (`"12,50"` o `"12.50"`) → centavos.
 * `null` cuando el campo está vacío o no es un número válido: nunca NaN.
 * Sirve para los formularios del comercio, no para mostrar dinero.
 */
export function parseMoneyInputToCents(value: string | null | undefined): number | null {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!raw) return null;
  const units = Number(raw);
  if (!Number.isFinite(units) || units < 0) return null;
  return unitsToCents(units);
}

/** Centavos → texto editable con 2 decimales (`"12.50"`). Solo para inputs. */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '';
  return centsToUnits(cents).toFixed(2);
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
  return formatMoney(unitsToCents(value), currency, locale);
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
