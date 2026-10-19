/**
 * config/business.ts — datos visibles del negocio, en UN solo lugar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  REGLA: NO INVENTAR DATOS LEGALES
 *
 *  Razón social, RUC, dirección, correo legal, plazos de reembolso y
 *  jurisdicción todavía NO están definidos por el negocio. Acá quedan en `null`
 *  y las páginas muestran un placeholder explícito (`[PENDIENTE: …]`), nunca un
 *  dato que parezca definitivo.
 *
 *  Cuando el negocio confirme cada dato, se completa acá y todas las páginas
 *  (legales, contacto, footer) se actualizan solas. No hay que tocar el texto
 *  página por página.
 *
 *  Este archivo NO contiene secretos: solo datos públicos (o pendientes).
 *  Cuando exista Multi-Tienda, estos valores pasarán a la entidad Store; no se
 *  modela todavía.
 * ─────────────────────────────────────────────────────────────────────────────
 */

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

export interface BusinessConfig {
  /** Nombre comercial visible. */
  name: string;
  /** Razón social registrada (pendiente). */
  legalName: string | null;
  /** RUC (pendiente). */
  ruc: string | null;
  /** Domicilio fiscal / atención al público (pendiente). */
  address: string | null;
  /** Correo de atención general (pendiente). */
  email: string | null;
  /** Correo para asuntos legales/privacidad (pendiente). */
  legalEmail: string | null;
  /** WhatsApp de ventas (se configura por entorno, no se inventa). */
  whatsapp: string | null;
  /** Teléfono de soporte (pendiente). */
  phone: string | null;
  /** Redes sociales verificadas (pendiente). */
  social: {
    instagram: string | null;
    tiktok: string | null;
  };
  /** Jurisdicción aplicable (pendiente de definición legal). */
  jurisdiction: string | null;
  /** Plazo de reembolso en días (pendiente de definición del negocio). */
  refundWindowDays: number | null;
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
  email: readPublicEnv('CONTACT_TO_EMAIL'),
  legalEmail: readPublicEnv('LEGAL_EMAIL'),
  whatsapp: readPublicEnv('NEXT_PUBLIC_WHATSAPP_SALES_PHONE'),
  phone: null,
  social: {
    instagram: null,
    tiktok: null,
  },
  jurisdiction: null,
  refundWindowDays: null,
  siteUrl: resolveSiteUrl(),
};

/** Campos que el negocio todavía debe confirmar (para diagnóstico/tests). */
export const PENDING_BUSINESS_FIELDS = {
  legalName: 'razón social',
  ruc: 'RUC',
  address: 'dirección legal',
  legalEmail: 'correo legal',
  jurisdiction: 'jurisdicción',
  refundWindowDays: 'plazo de reembolso',
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

/** Valor o placeholder. Nunca devuelve `null` hacia la UI. */
export function businessValue(field: PendingBusinessField): string {
  return isPendingBusinessField(field) ? pendingLabel(field) : String(businessConfig[field]);
}

/** Lista de campos aún pendientes (vacía = listo para publicar legalmente). */
export function pendingBusinessFields(): PendingBusinessField[] {
  return (Object.keys(PENDING_BUSINESS_FIELDS) as PendingBusinessField[]).filter(isPendingBusinessField);
}
