/**
 * lib/store-identity.ts — identidad pública de una tienda (nombre + slug).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  REGLAS
 *
 *  · El slug se normaliza con `normalizeStoreSlug` (minúsculas, sin tildes, sin
 *    guiones repetidos) y pasa `validateStoreSlug`: formato y rutas reservadas.
 *  · La unicidad es case-insensitive y la garantiza la base (`uq_stores_slug`
 *    sobre `lower(slug)`); acá solo se valida la forma.
 *  · No se permiten cadenas vacías ni un nombre fuera de 2–80 caracteres.
 *  · El slug NO describe la ubicación: `/mancora` no implica un distrito. La
 *    ubicación vive en `stores.ubigeo` + lat/lng y se edita aparte.
 *  · Solo se puede editar mientras la tienda NO haya sido publicada
 *    (`active = FALSE` y `approved_at IS NULL`). Una tienda publicada conserva
 *    su dirección hasta que existan aliases/redirects 301.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { normalizeStoreSlug, validateStoreSlug } from './tenancy';

/** Dominio público que se muestra en el panel (sin protocolo ni barra final). */
export const PUBLIC_STORE_HOST = 'umantai.com';

/** `umantai.com/juan-s-store` — lo que el comerciante ve antes de guardar. */
export function publicStoreUrl(slug: string): string {
  const normalized = normalizeStoreSlug(slug);
  return normalized ? `${PUBLIC_STORE_HOST}/${normalized}` : PUBLIC_STORE_HOST;
}

export type StoreIdentityValidation =
  | { ok: true; value: { name: string; slug: string } }
  | {
      ok: false;
      code: 'invalid_name' | 'slug_too_short' | 'slug_invalid' | 'slug_reserved';
      field: 'name' | 'slug';
      message: string;
    };

export interface StoreIdentityInput {
  name?: unknown;
  slug?: unknown;
}

export function validateStoreIdentity(input: StoreIdentityInput): StoreIdentityValidation {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 2 || name.length > 80) {
    return {
      ok: false,
      code: 'invalid_name',
      field: 'name',
      message: 'El nombre de la tienda debe tener entre 2 y 80 caracteres.',
    };
  }

  if (typeof input.slug !== 'string' || input.slug.trim() === '') {
    return {
      ok: false,
      code: 'slug_invalid',
      field: 'slug',
      message: 'Escribe una dirección pública para tu tienda.',
    };
  }

  const slug = validateStoreSlug(input.slug);
  if (!slug.ok) {
    return { ok: false, code: slug.code, field: 'slug', message: slug.message };
  }

  return { ok: true, value: { name, slug: slug.slug } };
}

export interface StoreIdentitySource {
  active: boolean;
  approvedAt: string | null;
}

/**
 * Editable mientras la tienda nunca haya sido publicada. Cambiar el slug de una
 * tienda activa rompería enlaces y pedidos sin redirect 301: hoy se bloquea.
 */
export function canEditStoreIdentity(store: StoreIdentitySource): boolean {
  return !store.active && store.approvedAt === null;
}
