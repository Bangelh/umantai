import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Product } from './products';
import { buildVariantKey, normalizeVariantSelection, type ProductVariant } from './commerce';

export interface CartItem extends Product {
  quantity: number;
  /**
   * Opciones genéricas seleccionadas: `{ color: 'negro', talla: 'M' }`.
   * Es la forma nueva y la que alimenta `variant_key` en el checkout.
   */
  selectedOptions?: Record<string, string>;
  /**
   * @deprecated Campos del carrito antiguo. Se conservan SOLO para leer carritos
   * ya persistidos en localStorage; todo item nuevo usa `selectedOptions`.
   */
  selectedColor?: string;
  selectedStorage?: string;
}

/** Forma mínima que identifica una línea (sirve para carritos viejos y nuevos). */
export type CartLineIdentity = Pick<CartItem, 'slug'> & {
  selectedOptions?: Record<string, string>;
  selectedColor?: string;
  selectedStorage?: string;
};

/**
 * Opciones efectivas de una línea, normalizando el formato legacy.
 *
 * Un carrito guardado antes de este cambio solo trae `selectedColor`/`selectedStorage`;
 * este helper lo traduce al modelo genérico sin mutar el item persistido.
 */
export function cartItemVariant(item: CartLineIdentity): ProductVariant {
  if (item.selectedOptions && Object.keys(item.selectedOptions).length > 0) {
    return normalizeVariantSelection(item.selectedOptions);
  }
  return normalizeVariantSelection({ color: item.selectedColor, storage: item.selectedStorage });
}

/**
 * Identificador estable de una LÍNEA del carrito: un producto + una combinación de
 * variante.
 *
 * El mismo `slug` puede aparecer varias veces con distinta variante, así que el slug
 * NO es una clave única. Toda operación que apunte a una sola línea (cantidad, borrar,
 * `key` de React) debe usar esto. Se deriva de los campos persistidos, por lo que los
 * carritos guardados siguen funcionando sin migración.
 */
export function cartLineKey(item: CartLineIdentity): string {
  return [item.slug, buildVariantKey(cartItemVariant(item))].join('::');
}

interface CartStore {
  items: CartItem[];
  addItem: (product: Product, quantity?: number, options?: ProductVariant) => void;
  removeItem: (lineKey: string) => void;
  updateQuantity: (lineKey: string, quantity: number) => void;
  clearCart: () => void;
  getTotalItems: () => number;
  getTotalPrice: () => number;
}

export const useCartStore = create<CartStore>()(
  persist(
    (set, get) => ({
      items: [],

      addItem: (product, quantity = 1, options) => {
        const normalized = normalizeVariantSelection(options);
        const selectedOptions = Object.keys(normalized).length > 0 ? (normalized as Record<string, string>) : undefined;

        const existing = get().items.findIndex(
          (item) => cartLineKey(item) === cartLineKey({ slug: product.slug, selectedOptions }),
        );

        if (existing !== -1) {
          const updated = [...get().items];
          updated[existing].quantity += quantity;
          set({ items: updated });
        } else {
          set({
            items: [...get().items, { ...product, quantity, selectedOptions }],
          });
        }
      },

      removeItem: (lineKey) => {
        set({
          items: get().items.filter((item) => cartLineKey(item) !== lineKey),
        });
      },

      updateQuantity: (lineKey, quantity) => {
        if (quantity < 1) return;
        set({
          items: get().items.map((item) =>
            cartLineKey(item) === lineKey ? { ...item, quantity } : item
          ),
        });
      },

      clearCart: () => set({ items: [] }),

      getTotalItems: () => get().items.reduce((sum, item) => sum + item.quantity, 0),

      getTotalPrice: () =>
        get().items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    }),
    {
      name: 'umantai-cart',
    }
  )
);
