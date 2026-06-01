import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Product } from './products';

export interface CartItem extends Product {
  quantity: number;
  selectedColor?: string;
  selectedStorage?: string;
}

interface CartStore {
  items: CartItem[];
  addItem: (product: Product, quantity?: number, color?: string, storage?: string) => void;
  removeItem: (slug: string) => void;
  updateQuantity: (slug: string, quantity: number) => void;
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

      removeItem: (slug) => {
        set({
          items: get().items.filter((item) => item.slug !== slug),
        });
      },

      updateQuantity: (slug, quantity) => {
        if (quantity < 1) return;
        set({
          items: get().items.map((item) =>
            item.slug === slug ? { ...item, quantity } : item
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
