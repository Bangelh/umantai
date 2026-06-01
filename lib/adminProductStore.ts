import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Product } from './products';

export interface ProductOverride {
  // Basic info
  name?: string;
  
  // Basic pricing & inventory
  price?: number;
  inStock?: number;

  // Extended editable fields
  description?: string;
  category?: string;
  subcategory?: string;
  images?: string[];
  brand?: string;
  rating?: number;
  reviewCount?: number;
  bestseller?: boolean;
}

interface AdminProductStore {
  // Local preview overrides (used in admin for live editing)
  overrides: Record<string, ProductOverride>;
  
  // Published overrides loaded from Postgres (used by public site)
  publishedOverrides: Record<string, ProductOverride>;
  
  isLoadedFromDB: boolean;
  
  // Actions
  updateProduct: (slug: string, changes: Partial<ProductOverride>) => void;
  resetProduct: (slug: string) => void;
  resetAll: () => void;
  
  // Load published overrides from Vercel Postgres
  loadFromDatabase: () => Promise<void>;
  
  // Push current local overrides to the database (used for migration)
  migrateLocalChangesToDatabase: () => Promise<{ success: boolean; count: number; message?: string }>;
  
  // Get effective value for a single product.
  // In admin: local overrides win for preview.
  // On public site: published overrides from DB are used.
  getEffectiveProduct: (baseProduct: Product) => Product;
}

export const useAdminProductStore = create<AdminProductStore>()(
  persist(
    (set, get) => ({
      overrides: {},
      publishedOverrides: {},
      isLoadedFromDB: false,

      updateProduct: (slug, changes) => {
        set((state) => ({
          overrides: {
            ...state.overrides,
            [slug]: {
              ...state.overrides[slug],
              ...changes,
            },
          },
        }));
      },

      resetProduct: (slug) => {
        set((state) => {
          const newOverrides = { ...state.overrides };
          delete newOverrides[slug];
          return { overrides: newOverrides };
        });
      },

      resetAll: () => set({ overrides: {}, publishedOverrides: {} }),

      loadFromDatabase: async () => {
        try {
          const res = await fetch('/api/admin/overrides');
          const data = await res.json();
          
          if (data.overrides) {
            set({ 
              publishedOverrides: data.overrides,
              isLoadedFromDB: true 
            });
          }
        } catch (error) {
          console.error('Failed to load overrides from database:', error);
        }
      },

      migrateLocalChangesToDatabase: async () => {
        const currentOverrides = get().overrides;
        const count = Object.keys(currentOverrides).length;

        if (count === 0) {
          return { success: false, count: 0, message: 'No local changes to migrate.' };
        }

        try {
          const res = await fetch('/api/admin/overrides', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ overrides: currentOverrides }),
          });

          if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.error || 'Failed to migrate changes');
          }

          // After successful migration, refresh published data
          const publishedRes = await fetch('/api/admin/overrides');
          const publishedData = await publishedRes.json();

          if (publishedData.overrides) {
            set({ publishedOverrides: publishedData.overrides });
          }

          return {
            success: true,
            count,
            message: `Successfully migrated ${count} change(s) to the database.`,
          };
        } catch (error: any) {
          console.error('Migration failed:', error);
          return {
            success: false,
            count,
            message: error.message || 'Migration failed. Check console for details.',
          };
        }
      },

      getEffectiveProduct: (baseProduct) => {
        const state = get();
        
        // Priority:
        // 1. Local admin preview overrides (for live editing in /admin)
        // 2. Published overrides from Postgres
        // 3. Base product data
        const localOverride = state.overrides[baseProduct.slug];
        const publishedOverride = state.publishedOverrides[baseProduct.slug];
        
        const effectiveOverride = localOverride || publishedOverride;
        
        if (!effectiveOverride) return baseProduct;

        return {
          ...baseProduct,
          ...effectiveOverride,
        };
      },
    }),
    {
      name: 'umantai-admin-products',
    }
  )
);

// ============================================
// Helper functions (use these across the app)
// ============================================

import { baseProductsData as baseProducts } from './products';

/**
 * Returns all products with admin overrides applied (from DB or local preview).
 */
export function getAllProducts(): Product[] {
  const store = useAdminProductStore.getState();
  return baseProducts.map((product) => store.getEffectiveProduct(product));
}

/**
 * Returns only products that have stock > 0 (after admin overrides).
 */
export function getAvailableProducts(): Product[] {
  return getAllProducts().filter((p) => p.inStock > 0);
}

/**
 * Get a single product by slug, with admin overrides applied.
 */
export function getProductBySlug(slug: string): Product | undefined {
  const base = baseProducts.find((p) => p.slug === slug);
  if (!base) return undefined;

  return useAdminProductStore.getState().getEffectiveProduct(base);
}

/**
 * Get bestsellers that are currently available (after admin overrides).
 */
export function getBestsellers(limit = 5): Product[] {
  return getAllProducts()
    .filter((p) => p.bestseller && p.inStock > 0)
    .slice(0, limit);
}