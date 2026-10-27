/**
 * config/business.ts — datos visibles del negocio, en UN solo lugar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  REGLA: NO INVENTAR DATOS LEGALES
 *
 *  Razón social, RUC, domicilio fiscal, dirección y jurisdicción todavía NO
 *  están definidos por el negocio. Acá quedan en `null` y las páginas muestran
 *  un placeholder explícito (`[PENDIENTE: …]`), nunca un dato que parezca
 *  definitivo.
 *
 *  Cuando el negocio confirme cada dato, se completa acá y todas las páginas
 *  (legales, contacto, footer) se actualizan solas. No hay que tocar el texto
 *  página por página.
 *
 *  Mientras quede un solo campo pendiente, `isLegalReadyForLaunch()` es `false`
 *  y las páginas legales NO pueden considerarse definitivas para lanzamiento
 *  público.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  CONTACTO REAL (confirmado 2026-10-24)
 *
 *  Correo de atención, correo legal y WhatsApp se centralizan acá. Cada valor
 *  puede sobrescribirse por entorno (CONTACT_TO_EMAIL, LEGAL_EMAIL,
 *  NEXT_PUBLIC_WHATSAPP_SALES_PHONE) sin cambiar código ni duplicar el dato en
 *  páginas. Son datos públicos de contacto: NO hay secretos en este archivo.
 * ─────────────────────────────────────────────────────────────────────────────
 *  DATOS LEGALES DEMO (solo revisión visual en staging)
 *
 *  Con `LEGAL_DEMO_DATA=1` **y** un entorno no productivo, los campos todavía
 *  pendientes se muestran con valores de ejemplo (`config/legal-demo.ts`) en vez
 *  del placeholder, siempre acompañados del aviso visible “DATOS DE
 *  DEMOSTRACIÓN — NO VÁLIDOS PARA PRODUCCIÓN”.
 *
 *  En Producción la bandera se IGNORA (ver `isLegalDemoDataActive`), los datos
 *  demo nunca cuentan como reales y `isLegalReadyForLaunch()` sigue en `false`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { isProductionRuntime } from '@/lib/runtime-environment.server';

import {
  LEGAL_DEMO_DATA_FLAG,
  LEGAL_DEMO_VALUES,
  isLegalDemoFlagEnabled,
} from './legal-demo';

/**
 * Lee una variable pública con los prefijos de integración de Vercel.
 * Se evita importar `lib/env.ts` a propósito: ese módulo construye la config
 * completa (y valida VERCEL_ENV) al importarse; acá solo hacen falta strings.
 */
function readPublicEnv(name: string): string | null {
  const candidates = [
    process.env[name],
    process.env[`BANGELH_${name}`],
    process.env[`UMANTAI_URL_${name}`],
    process.env[`UMANTAI_${name}`],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/** Marca visible. Ya existe en la app, no es un dato inventado. */
const BRAND_NAME = 'Umantai';

/** Correo de atención al cliente confirmado por el negocio. */
const DEFAULT_CONTACT_EMAIL = 'juancallerosales19@gmail.com';

/** Correo para asuntos legales/privacidad confirmado por el negocio. */
const DEFAULT_LEGAL_EMAIL = 'juancallerosales19@gmail.com';

/** WhatsApp de ventas/atención confirmado por el negocio (sin código de país). */
const DEFAULT_WHATSAPP_NUMBER = '979363149';

/** Perú (+51). El sitio vende en soles y opera en Perú. */
const DEFAULT_WHATSAPP_COUNTRY_CODE = '51';

/** Placeholder cuando no hay correo legal configurado. */
export const LEGAL_EMAIL_PENDING_LABEL = '[PENDIENTE: definir correo legal]';

export interface BusinessConfig {
  /** Nombre comercial visible. */
  name: string;
  /** Razón social registrada (pendiente). */
  legalName: string | null;
  /** RUC (pendiente). */
  ruc: string | null;
  /** Domicilio fiscal / atención al público (pendiente). */
  address: string | null;
  /** Correo de atención general. */
  email: string;
  /** Correo para asuntos legales/privacidad. */
  legalEmail: string;
  /** WhatsApp de ventas/atención, tal como lo dictó el negocio. */
  whatsapp: string;
  /** Código de país para armar el enlace `wa.me` (+51). */
  whatsappCountryCode: string;
  /** Teléfono de soporte (mismo canal de WhatsApp). */
  phone: string | null;
  /** Redes sociales verificadas (pendiente). */
  social: {
    instagram: string | null;
    tiktok: string | null;
  };
  /** Jurisdicción aplicable (pendiente de definición legal). */
  jurisdiction: string | null;
  /** URL pública del sitio, para metadata/canonical/sitemap. */
  siteUrl: string;
}

/**
 * URL pública. Se resuelve por entorno:
 *   NEXT_PUBLIC_SITE_URL > NEXT_PUBLIC_SERVER_URL > umantai.com
 * En desarrollo local se usa localhost para no emitir canonicals de producción.
 */
function resolveSiteUrl(): string {
  const explicit = readPublicEnv('NEXT_PUBLIC_SITE_URL') ?? readPublicEnv('NEXT_PUBLIC_SERVER_URL');
  if (explicit) return explicit.replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'development') return 'http://localhost:3000';
  return 'https://umantai.com';
}

export const businessConfig: BusinessConfig = {
  name: BRAND_NAME,
  legalName: null,
  ruc: null,
  address: null,
  email: readPublicEnv('CONTACT_TO_EMAIL') ?? DEFAULT_CONTACT_EMAIL,
  legalEmail: readPublicEnv('LEGAL_EMAIL') ?? DEFAULT_LEGAL_EMAIL,
  whatsapp: readPublicEnv('NEXT_PUBLIC_WHATSAPP_SALES_PHONE') ?? DEFAULT_WHATSAPP_NUMBER,
  whatsappCountryCode: DEFAULT_WHATSAPP_COUNTRY_CODE,
  phone: null,
  social: {
    instagram: null,
    tiktok: null,
  },
  jurisdiction: null,
  siteUrl: resolveSiteUrl(),
};

/** Campos que el negocio todavía debe confirmar (para diagnóstico/tests). */
export const PENDING_BUSINESS_FIELDS = {
  legalName: 'razón social',
  ruc: 'RUC',
  address: 'dirección legal',
  jurisdiction: 'jurisdicción',
} as const satisfies Record<string, string>;

export type PendingBusinessField = keyof typeof PENDING_BUSINESS_FIELDS;

export function isPendingBusinessField(field: PendingBusinessField): boolean {
  const value = businessConfig[field];
  return value === null || value === undefined || (typeof value === 'string' && !value.trim());
}

/** `[PENDIENTE: definir razón social]` — visible y sin ambigüedad. */
export function pendingLabel(field: PendingBusinessField): string {
  return `[PENDIENTE: definir ${PENDING_BUSINESS_FIELDS[field]}]`;
}

/**
 * Valor real, dato de DEMOSTRACIÓN (solo fuera de Producción) o placeholder.
 * Nunca devuelve `null` hacia la UI, y un dato real siempre gana sobre el demo.
 */
export function businessValue(field: PendingBusinessField): string {
  if (!isPendingBusinessField(field)) return String(businessConfig[field]);
  return isLegalDemoDataActive() ? LEGAL_DEMO_VALUES[field] : pendingLabel(field);
}

/** Lista de campos aún pendientes (vacía = listo para publicar legalmente). */
export function pendingBusinessFields(): PendingBusinessField[] {
  return (Object.keys(PENDING_BUSINESS_FIELDS) as PendingBusinessField[]).filter(isPendingBusinessField);
}

/** Se avisa UNA sola vez por proceso; nunca se imprime el valor de la variable. */
let warnedAboutDemoInProduction = false;

/**
 * ¿Se están mostrando datos legales de DEMOSTRACIÓN?
 *
 * Hacen falta las dos condiciones, en este orden:
 *
 *   1. la bandera explícita `LEGAL_DEMO_DATA=1`;
 *   2. un entorno NO productivo. Fuera de ahí —`APP_ENV=production`,
 *      `VERCEL_ENV=production` o un `APP_ENV` desconocido, que
 *      `resolveRuntimeEnvironment` trata como Producción (fail-closed)— la
 *      bandera se ignora y se avisa una vez por proceso.
 *
 * Es decir: los datos demo no pueden llegar a Producción ni por error de
 * configuración, y menos aún considerarse válidos para el cutover.
 */
export function isLegalDemoDataActive(): boolean {
  if (!isLegalDemoFlagEnabled(readPublicEnv(LEGAL_DEMO_DATA_FLAG))) return false;

  if (isProductionRuntime()) {
    if (!warnedAboutDemoInProduction) {
      warnedAboutDemoInProduction = true;
      console.warn(
        `[legal-demo] ${LEGAL_DEMO_DATA_FLAG} está presente en Producción: se ignora. ` +
          'Los datos de demostración solo se muestran fuera de Producción.',
      );
    }
    return false;
  }

  return true;
}

/**
 * ¿Los documentos legales pueden considerarse definitivos para lanzamiento?
 *
 * `false` mientras falte cualquier dato del titular y `false` también mientras se
 * estén mostrando datos de DEMOSTRACIÓN: son falsos por definición, así que no
 * sirven para el cutover. Es un candado de lectura: lo usan las páginas legales y
 * los tests para que un placeholder no pase inadvertido a Producción.
 */
export function isLegalReadyForLaunch(): boolean {
  if (isLegalDemoDataActive()) return false;
  return pendingBusinessFields().length === 0;
}

/** Contacto legal listo para mostrar (nunca `null`). */
export function legalContactEmail(): string {
  return businessConfig.legalEmail.trim() || LEGAL_EMAIL_PENDING_LABEL;
}

/**
 * Número para `wa.me`: solo dígitos y con código de país.
 * Si el valor ya trae código de país (más de 9 dígitos), se respeta.
 */
export function whatsappNumber(): string | null {
  const digits = businessConfig.whatsapp.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length > 9) return digits;
  return `${businessConfig.whatsappCountryCode}${digits}`;
}

/** Enlace de WhatsApp con mensaje opcional. `null` si no hay número. */
export function whatsappUrl(message?: string): string | null {
  const number = whatsappNumber();
  if (!number) return null;
  const base = `https://wa.me/${number}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

/** Texto visible: `+51979363149`. */
export function whatsappDisplay(): string {
  const number = whatsappNumber();
  return number ? `+${number}` : '';
}
