/**
 * Acceso a una tienda desde el panel del comerciante.
 *
 * `cache` memoiza por request, así el layout y la página del segmento comparten
 * una sola consulta de membresía. Devuelve `null` en vez de lanzar para que el
 * llamador decida el estado HTTP (`notFound()`).
 */

import { cache } from 'react';
import { requireStoreAccess } from './stores.server';

export const loadStoreAccess = cache(async (userId: string, storeId: string) => {
  try {
    return await requireStoreAccess(userId, storeId);
  } catch {
    return null;
  }
});
