import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Product } from './products';

export interface CartItem extends Product {
  quantity: number;
  selectedColor?: string;
  selectedStorage?: string;
}

/**
 * Identificador estable de una LÍNEA del carrito: un producto + una combinación de variante.
 *
 * El mismo `slug` puede aparecer varias veces con distinto color/almacenamiento, así que el
 * slug NO es una clave única. Toda operación que apunte a una sola línea (cantidad, borrar,
 * `key` de React) debe usar esto.
 *
 * Se deriva de los campos ya persistidos, así que los carritos guardados en localStorage
 * siguen funcionando sin migración.
 */
export function cartLineKey(
  item: Pick<CartItem, 'slug' | 'selectedColor' | 'selectedStorage'>,
): string {
  return [item.slug, item.selectedColor ?? '', item.selectedStorage ?? ''].join('::');
}

interface CartStore {
  items: CartItem[];
  addItem: (product: Product, quantity?: number, color?: string, storage?: string) => void;
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

      addItem: (product, quantity = 1, color, storage) => {
        const existing = get().items.findIndex(
          (item) => 
            item.slug === product.slug && 
            item.selectedColor === color && 
            item.selectedStorage === storage
        );

        if (existing !== -1) {
          const updated = [...get().items];
          updated[existing].quantity += quantity;
          set({ items: updated });
        } else {
          set({
            items: [...get().items, { ...product, quantity, selectedColor: color, selectedStorage: storage }],
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
