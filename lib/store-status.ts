/**
 * lib/store-status.ts — el estado REAL de una tienda, en un solo lugar.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  QUÉ SIGNIFICA "PENDIENTE" HOY
 *
 *  La base solo guarda un booleano (`stores.active`) más `approved_at`. No hay
 *  un enum de estados ni un proceso de revisión automático: una tienda nace
 *  `active = FALSE` y sigue así hasta que un Platform Admin la activa desde
 *  `/admin/tiendas` (API `PATCH /api/admin/stores`).
 *
 *  Pero "inactiva" mezcla dos situaciones muy distintas para el comerciante:
 *
 *    · le falta un requisito que solo él puede completar (la ubicación), o
 *    · está completa y espera la revisión de un administrador.
 *
 *  El constraint `stores_active_location_chk` exige latitud y longitud para
 *  activar. Sin ellos, el administrador recibe `store_location_required` y la
 *  tienda no puede publicarse NUNCA. Decirle "pendiente" a esa tienda es mentir:
 *  no está esperando revisión, está esperando al comerciante.
 *
 *  Este módulo deriva el estado visible desde la fila de `stores` (sin columnas
 *  nuevas) para que /cuenta, /negocio y /admin/tiendas digan lo mismo.
 *
 *  La verificación de CORREO de la cuenta es un estado independiente
 *  (`users."emailVerified"`) y NO decide si la tienda se publica.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type MerchantStoreState = 'active' | 'pending_review' | 'incomplete';

export interface MerchantStoreStatus {
  state: MerchantStoreState;
  /** La tienda tiene coordenadas: puede pasar el constraint de activación. */
  hasLocation: boolean;
  /** Un administrador puede activarla ahora mismo. */
  canActivate: boolean;
  /** Requisito que solo el comerciante puede completar (null si no falta nada). */
  missing: 'location' | null;
}

export interface StoreStatusSource {
  active: boolean;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Deriva el estado visible de una tienda.
 *
 *   active = TRUE                          → 'active'
 *   active = FALSE, sin latitud/longitud   → 'incomplete'
 *   active = FALSE, con ubicación          → 'pending_review'
 */
export function resolveMerchantStoreStatus(store: StoreStatusSource): MerchantStoreStatus {
  const hasLocation = store.latitude !== null && store.longitude !== null;

  if (store.active) {
    return { state: 'active', hasLocation, canActivate: false, missing: null };
  }

  if (!hasLocation) {
    return { state: 'incomplete', hasLocation: false, canActivate: false, missing: 'location' };
  }

  return { state: 'pending_review', hasLocation: true, canActivate: true, missing: null };
}
