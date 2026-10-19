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
  /** @deprecated Campos del carrito antiguo. Solo para leer carritos persistidos. */
  selectedColor?: string;
  selectedStorage?: string;
}

export type CartLineIdentity = Pick<CartItem, 'slug'> & {
  selectedOptions?: Record<string, string>;
  selectedColor?: string;
  selectedStorage?: string;
  storeSlug?: string;
};

export interface CartStoreIdentity {
  storeId: string | null;
  storeSlug: string | null;
  storeName: string | null;
}

export interface CartConflict {
  status: 'conflict';
  current: CartStoreIdentity;
  next: CartStoreIdentity;
}

export type AddItemResult = { status: 'added' } | CartConflict;

export function cartItemVariant(item: CartLineIdentity): ProductVariant {
  if (item.selectedOptions && Object.keys(item.selectedOptions).length > 0) {
    return normalizeVariantSelection(item.selectedOptions);
  }
  return normalizeVariantSelection({ color: item.selectedColor, storage: item.selectedStorage });
}

/** Identificador de una línea: tienda + producto + combinación de variante. */
export function cartLineKey(item: CartLineIdentity): string {
  return [item.storeSlug ?? '', item.slug, buildVariantKey(cartItemVariant(item))].join('::');
}

function identityOfProduct(product: Product): CartStoreIdentity {
  return {
    storeId: product.storeId ?? null,
    storeSlug: product.storeSlug ?? null,
    storeName: product.storeName ?? null,
  };
}

function identityOfState(
  state: Pick<CartStore, 'items' | 'storeId' | 'storeSlug' | 'storeName'>,
): CartStoreIdentity {
  if (state.storeSlug || state.storeId) {
    return { storeId: state.storeId, storeSlug: state.storeSlug, storeName: state.storeName };
  }
  const first = state.items[0];
  return {
    storeId: first?.storeId ?? null,
    storeSlug: first?.storeSlug ?? null,
    storeName: first?.storeName ?? null,
  };
}

function sameStore(a: CartStoreIdentity, b: CartStoreIdentity): boolean {
  if (!a.storeSlug && !b.storeSlug) return true;
  return a.storeSlug === b.storeSlug;
}

interface CartStore extends CartStoreIdentity {
  items: CartItem[];
  /**
   * Agrega una línea. Si el carrito ya pertenece a otra tienda devuelve
   * `conflict` y NO modifica nada: la confirmación es explícita en la UI.
   */
  addItem: (product: Product, quantity?: number, options?: ProductVariant) => AddItemResult;
  /** Reemplaza el carrito por el de otra tienda (solo tras confirmación). */
  switchStore: (product: Product, quantity?: number, options?: ProductVariant) => void;
  removeItem: (lineKey: string) => void;
  updateQuantity: (lineKey: string, quantity: number) => void;
  clearCart: () => void;
  getTotalItems: () => number;
  getTotalPrice: () => number;
  getStore: () => CartStoreIdentity;
}

function buildLine(product: Product, quantity: number, options?: ProductVariant): CartItem {
  const normalized = normalizeVariantSelection(options);
  const selectedOptions =
    Object.keys(normalized).length > 0 ? (normalized as Record<string, string>) : undefined;
  return { ...product, quantity, selectedOptions };
}

export const useCartStore = create<CartStore>()(
  persist(
    (set, get) => ({
      items: [],
      storeId: null,
      storeSlug: null,
      storeName: null,

      addItem: (product, quantity = 1, options) => {
        const current = identityOfState(get());
        const next = identityOfProduct(product);

        if (get().items.length > 0 && !sameStore(current, next)) {
          return { status: 'conflict', current, next };
        }

        const line = buildLine(product, quantity, options);
        const existing = get().items.findIndex(
          (item) => cartLineKey(item) === cartLineKey(line),
        );

        if (existing !== -1) {
          const updated = [...get().items];
          updated[existing] = {
            ...updated[existing],
            quantity: updated[existing].quantity + quantity,
          };
          set({ items: updated, ...next });
        } else {
          set({ items: [...get().items, line], ...next });
        }
        return { status: 'added' };
      },

      switchStore: (product, quantity = 1, options) => {
        const next = identityOfProduct(product);
        set({ items: [buildLine(product, quantity, options)], ...next });
      },

      removeItem: (lineKey) => {
        const items = get().items.filter((item) => cartLineKey(item) !== lineKey);
        if (items.length === 0) {
          set({ items: [], storeId: null, storeSlug: null, storeName: null });
        } else {
          set({ items });
        }
      },

      updateQuantity: (lineKey, quantity) => {
        if (quantity < 1) return;
        set({
          items: get().items.map((item) =>
            cartLineKey(item) === lineKey ? { ...item, quantity } : item,
          ),
        });
      },

      clearCart: () =>
        set({ items: [], storeId: null, storeSlug: null, storeName: null }),

      getTotalItems: () => get().items.reduce((sum, item) => sum + item.quantity, 0),

      getTotalPrice: () =>
        get().items.reduce((sum, item) => sum + item.price * item.quantity, 0),

      getStore: () => identityOfState(get()),
    }),
    {
      name: 'umantai-cart',
      // Carritos anteriores no tenían metadata de tienda: se deriva de la
      // primera línea, sin descartar el contenido.
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<CartStore>;
        const items = Array.isArray(stored.items) ? stored.items : [];
        const first = items[0];
        return {
          ...current,
          ...stored,
          items,
          storeId: stored.storeId ?? first?.storeId ?? null,
          storeSlug: stored.storeSlug ?? first?.storeSlug ?? null,
          storeName: stored.storeName ?? first?.storeName ?? null,
        };
      },
    },
  ),
);
