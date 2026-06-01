import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Product } from './products';

export interface ShoppingListItem {
  id: string; // unique id for the list item
  product: Product;
  quantity: number;
  checked: boolean;
  note?: string;
}

interface ShoppingListStore {
  items: ShoppingListItem[];
  addItem: (product: Product, quantity?: number) => void;
  removeItem: (id: string) => void;
  toggleChecked: (id: string) => void;
  updateQuantity: (id: string, quantity: number) => void;
  updateNote: (id: string, note: string) => void;
  clearList: () => void;
  getTotalItems: () => number;
  reorderItems: (activeId: string, overId: string) => void;
}

export const useShoppingListStore = create<ShoppingListStore>()(
  persist(
    (set, get) => ({
      items: [],

      addItem: (product, quantity = 1) => {
        const existing = get().items.findIndex(item => item.product.slug === product.slug);

        if (existing !== -1) {
          const updated = [...get().items];
          updated[existing].quantity += quantity;
          set({ items: updated });
        } else {
          const newItem: ShoppingListItem = {
            id: `${product.slug}-${Date.now()}`,
            product,
            quantity,
            checked: false,
          };
          set({ items: [...get().items, newItem] });
        }
      },

      removeItem: (id) => {
        set({ items: get().items.filter(item => item.id !== id) });
      },

      toggleChecked: (id) => {
        set({
          items: get().items.map(item =>
            item.id === id ? { ...item, checked: !item.checked } : item
          ),
        });
      },

      updateQuantity: (id, quantity) => {
        if (quantity < 1) return;
        set({
          items: get().items.map(item =>
            item.id === id ? { ...item, quantity } : item
          ),
        });
      },

      updateNote: (id, note) => {
        set({
          items: get().items.map(item =>
            item.id === id ? { ...item, note } : item
          ),
        });
      },

      clearList: () => set({ items: [] }),

      getTotalItems: () => get().items.reduce((sum, item) => sum + item.quantity, 0),

      reorderItems: (activeId: string, overId: string) => {
        const { items } = get();
        const oldIndex = items.findIndex(item => item.id === activeId);
        const newIndex = items.findIndex(item => item.id === overId);

        if (oldIndex === -1 || newIndex === -1) return;

        const newItems = [...items];
        const [movedItem] = newItems.splice(oldIndex, 1);
        newItems.splice(newIndex, 0, movedItem);

        set({ items: newItems });
      },
    }),
    {
      name: 'umantai-shopping-list',
    }
  )
);
