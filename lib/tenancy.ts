/**
 * lib/tenancy.ts — reglas de tenancy que NO tocan la base de datos.
 *
 * Se usan en el formulario de alta, en las rutas y en los tests. La base aplica
 * las mismas reglas (trigger `stores_validate_slug` en 011), así que un script o
 * un bug de la app no puede saltárselas.
 */

/** Rutas de primer nivel que un comercio no puede reclamar. Espejo de la DB. */
export const RESERVED_STORE_SLUGS = new Set([
  'admin',
  'api',
  'login',
  'ingresar',
  'registro',
  'legal',
  'contacto',
  'products',
  'cart',
  'list',
  'kiosk',
  'kiosco',
  'pedido',
  'cuenta',
  'negocio',
  'vender',
  'search',
  'buscar',
  'debug',
  '_next',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  'brand',
  'images',
  'umantai',
]);

export const STORE_SLUG_MIN = 3;
export const STORE_SLUG_MAX = 60;

export type StoreRole = 'owner' | 'admin';

export const STORE_ROLES: readonly StoreRole[] = ['owner', 'admin'];

/** `owner` puede todo; `admin` opera el día a día pero no gestiona miembros. */
const ROLE_RANK: Record<StoreRole, number> = { admin: 1, owner: 2 };

export function isStoreRole(value: unknown): value is StoreRole {
  return value === 'owner' || value === 'admin';
}

export function roleAtLeast(role: StoreRole | null | undefined, minimum: StoreRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** `owner` o `admin` pueden operar catálogo/inventario/pedidos de SU tienda. */
export function canOperateStore(role: StoreRole | null | undefined): boolean {
  return roleAtLeast(role, 'admin');
}

export function canManageStoreMembers(role: StoreRole | null | undefined): boolean {
  return roleAtLeast(role, 'owner');
}

/**
 * Convierte un nombre comercial en slug:
 *   "Telas del Sur"      → "telas-del-sur"
 *   "Café & Té  Ñandú"   → "cafe-te-nandu"
 *   "  A--B  "           → "a-b"
 */
export function normalizeStoreSlug(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, STORE_SLUG_MAX)
    .replace(/-+$/g, '');
}

export type SlugValidation =
  | { ok: true; slug: string }
  | { ok: false; code: 'slug_too_short' | 'slug_invalid' | 'slug_reserved'; message: string };

export function validateStoreSlug(input: unknown): SlugValidation {
  if (typeof input !== 'string') {
    return { ok: false, code: 'slug_invalid', message: 'El slug debe ser texto.' };
  }

  const slug = normalizeStoreSlug(input);

  if (slug.length < STORE_SLUG_MIN) {
    return {
      ok: false,
      code: 'slug_too_short',
      message: `El slug debe tener al menos ${STORE_SLUG_MIN} caracteres.`,
    };
  }

  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) || slug.includes('--')) {
    return {
      ok: false,
      code: 'slug_invalid',
      message: 'Usa minúsculas, números y guiones (sin guion al inicio/fin).',
    };
  }

  if (RESERVED_STORE_SLUGS.has(slug)) {
    return {
      ok: false,
      code: 'slug_reserved',
      message: `"${slug}" es una ruta reservada de UMANTAI. Elige otro nombre.`,
    };
  }

  return { ok: true, slug };
}

/** Ruta pública de una tienda / de un producto de esa tienda. */
export function storePath(slug: string): string {
  return `/${slug}`;
}

export function storeProductPath(storeSlug: string, productSlug: string): string {
  return `/${storeSlug}/p/${productSlug}`;
}

/**
 * Códigos de error de tenancy. La ruta los traduce a HTTP; la capa de datos
 * NUNCA devuelve datos de otra tienda "porque el filtro falló": devuelve null o
 * lanza uno de estos.
 */
export type TenancyErrorCode =
  | 'store_not_found'
  | 'store_inactive'
  | 'store_forbidden'
  | 'not_authenticated'
  | 'store_slug_taken'
  | 'invalid_store_input'
  | 'store_product_slug_taken'
  | 'store_product_not_found';

export class TenancyError extends Error {
  readonly code: TenancyErrorCode;
  readonly status: number;

  constructor(code: TenancyErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'TenancyError';
    this.code = code;
    this.status =
      status ??
      (code === 'not_authenticated'
        ? 401
        : code === 'store_forbidden'
          ? 403
          : code === 'store_slug_taken' || code === 'store_product_slug_taken'
            ? 409
            : code === 'invalid_store_input'
              ? 400
              : 404);
  }
}
