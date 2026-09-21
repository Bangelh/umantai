"use client";

import { useSyncExternalStore } from "react";

/**
 * El "estado" no cambia nunca: lo único que cambia es de qué lado corre el render.
 * Por eso la suscripción es un no-op y solo hay dos snapshots.
 */
const subscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * `false` en el servidor y en el primer render del cliente; `true` desde que React
 * termina de hidratar.
 *
 * ─── POR QUÉ HACE FALTA ──────────────────────────────────────────────────────
 * Los carritos (`lib/cartStore.ts`, `lib/shoppingListStore.ts`) se persisten en
 * `localStorage` con `zustand/persist`. En el servidor no hay `localStorage`, así que
 * el store rinde vacío; en el cliente zustand REHIDRATA de forma síncrona al crear el
 * store, es decir, antes de que React hidrate el HTML.
 *
 * Resultado: el HTML del servidor se pintó con 0 items y el primer render del cliente
 * ya trae los del `localStorage` → React detecta que los árboles no coinciden y lanza
 * el "Hydration failed because the server rendered HTML didn't match the client".
 *
 * La salida es no pintar NADA que dependa del store hasta después de hidratar:
 * servidor y primer render del cliente devuelven lo mismo (el esqueleto) y solo
 * después aparecen los datos reales.
 *
 * ─── POR QUÉ `useSyncExternalStore` Y NO `useState` + `useEffect` ─────────────
 * React usa `getServerSnapshot` tanto en el servidor como durante la hidratación, y
 * recién después compara con `getClientSnapshot`: exactamente la semántica que
 * queremos, sin un `setState` dentro de un efecto (que provoca renders en cascada).
 *
 * Uso:
 *   const hydrated = useHydrated();
 *   if (!hydrated) return <Skeleton />;
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}

export default useHydrated;
