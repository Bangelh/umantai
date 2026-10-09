"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProductAvailabilityMap } from "./catalogAvailability";

/**
 * Disponibilidad real por variante para un conjunto de slugs.
 *
 * ─── POR QUÉ UN HOOK ─────────────────────────────────────────────────────────
 * La autoridad del stock es `inventory`, expuesta por `GET /api/catalog/availability`.
 * Antes solo la página de detalle la leía; el catálogo decidía con `inStock`
 * (presentación) y por eso dejaba agregar productos agotados.
 *
 * ─── POR QUÉ CLAVE POR STRING Y NO POR EL ARRAY ──────────────────────────────
 * Los llamadores arman el array en cada render (`map(p => p.slug)`), así que su
 * identidad cambia siempre. Depender del array dispararía un fetch por render; la
 * clave es el mismo conjunto de slugs ordenado y deduplicado, y solo cambia cuando
 * cambia de verdad el catálogo a consultar.
 *
 * ─── POR QUÉ LA RESPUESTA VA ETIQUETADA CON SU CLAVE ─────────────────────────
 * Así el valor devuelto nunca es de una consulta vieja: si la clave pedida no es la
 * que se guardó, el hook devuelve `null` (desconocido) en vez de mostrar stock de otro
 * conjunto de productos. También evita un `setState` síncrono dentro del efecto.
 *
 * ─── QUÉ SIGNIFICA `null` ────────────────────────────────────────────────────
 * No significa "sin stock": significa "todavía no sé". `purchaseAvailability()` trata
 * ese caso como "no autorizar". Si la petición falla, se queda en `null` a propósito:
 * preferimos no dejar comprar a ciegas antes que autorizar con datos que no tenemos.
 */
export function useCatalogAvailability(slugs: string[]): ProductAvailabilityMap | null {
  const key = useMemo(
    () => [...new Set(slugs.filter((slug) => Boolean(slug)))].sort().join(","),
    [slugs],
  );

  const [response, setResponse] = useState<{ key: string; map: ProductAvailabilityMap } | null>(
    null,
  );

  useEffect(() => {
    if (!key) return;

    let active = true;

    fetch(`/api/catalog/availability?slugs=${encodeURIComponent(key)}`, { cache: "no-store" })
      .then((result) => (result.ok ? result.json() : null))
      .then((data) => {
        if (!active || !data?.availability) return;
        setResponse({ key, map: data.availability as ProductAvailabilityMap });
      })
      .catch(() => {
        /* Sin inventario: el servidor sigue siendo la autoridad de la venta. */
      });

    return () => {
      active = false;
    };
  }, [key]);

  return response && response.key === key ? response.map : null;
}

export default useCatalogAvailability;
