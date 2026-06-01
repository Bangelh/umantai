"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { baseProducts } from "@/lib/products";
import { useAdminProductStore, ProductOverride } from "@/lib/adminProductStore";
import { wholeFoodsCategories } from "@/lib/categories";

// Types
type Section = "products" | "brands" | "categories" | "stock";

interface EditModalProps {
  product: any;
  onClose: () => void;
}

// Reusable Edit Modal (cleaned up)
function EditModal({ product, onClose }: EditModalProps) {
  const { overrides, updateProduct, resetProduct } = useAdminProductStore();
  const override = overrides[product.slug] || {};

  const [form, setForm] = useState({
    name: override.name ?? product.name,
    price: override.price ?? product.price,
    inStock: override.inStock ?? product.inStock,
    description: override.description ?? product.description,
    brand: override.brand ?? product.brand,
    category: override.category ?? product.category,
    subcategory: override.subcategory ?? product.subcategory ?? "",
    images: (override.images ?? product.images).join(", "),
    rating: override.rating ?? product.rating,
    reviewCount: override.reviewCount ?? product.reviewCount,
    bestseller: override.bestseller ?? product.bestseller ?? false,
  });

  // Full Tree Editor State
  const [categoryTree, setCategoryTree] = useState<any>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [selectedSubcategoryId, setSelectedSubcategoryId] = useState<number | null>(null);
  const [selectedCategoryPath, setSelectedCategoryPath] = useState<string>("");

  // Fetch category tree when modal opens
  useEffect(() => {
    async function fetchTree() {
      try {
        const res = await fetch('/api/categories/tree');
        const data = await res.json();
        if (data.success) {
          setCategoryTree(data.data);
        }
      } catch (e) {
        console.error("Failed to load category tree", e);
      }
    }
    fetchTree();
  }, []);

  // Handle selecting a leaf in the tree
  const handleSelectSubcategory = (node: any, parent: any) => {
    setSelectedSubcategoryId(node.id);
    setSelectedCategoryId(parent.id);
    setSelectedCategoryPath(`${parent.name} > ${node.name}`);

    // Update form for preview
    setForm(prev => ({
      ...prev,
      category: parent.name,
      subcategory: node.name,
    }));
  };

  const handleSave = async () => {
    const imagesArray = form.images
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);

    const changes: ProductOverride = {
      name: form.name,
      price: Number(form.price),
      inStock: Number(form.inStock),
      description: form.description,
      brand: form.brand,
      category: form.category,
      subcategory: form.subcategory || undefined,
      images: imagesArray,
      rating: Number(form.rating),
      reviewCount: Number(form.reviewCount),
      bestseller: form.bestseller,
    };

    // If user selected from the tree, prepare data for backend
    const updatePayload: any = { ...changes };

    if (selectedCategoryId && selectedSubcategoryId) {
      updatePayload.category_id = selectedCategoryId;
      updatePayload.subcategory_id = selectedSubcategoryId;
      updatePayload.category_path = selectedCategoryPath;
    }

    // 1. Update local preview (Zustand)
    updateProduct(product.slug, changes);

    // 2. Send to backend (Postgres) using the new PATCH endpoint
    try {
      await fetch(`/api/products/${product.slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload),
      });
    } catch (error) {
      console.error("Failed to persist category change to database", error);
      alert(
        "Category change saved locally but failed to save to database.\n\n" +
        "Tip: For local development, use POSTGRES_URL_NON_POOLING in .env.local " +
        "(run `vercel env pull .env.local` to get the latest vars)."
      );
    }

    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center p-6">
      <div className="bg-neutral-900 border border-white/20 rounded-3xl w-full max-w-3xl max-h-[90vh] overflow-auto">
        <div className="p-6 border-b border-white/10 flex justify-between items-center">
          <div>
            <div className="text-xl font-semibold">{product.name}</div>
            <div className="text-sm text-white/50">{product.slug}</div>
          </div>
          <button onClick={onClose} className="text-2xl text-white/60 hover:text-white">×</button>
        </div>

        <div className="p-6 space-y-6">
          {/* Product Name - Easy rename */}
          <div>
            <label className="text-xs text-white/60 block mb-1.5">PRODUCT NAME</label>
            <input 
              value={form.name} 
              onChange={(e) => setForm({ ...form, name: e.target.value })} 
              className="w-full bg-neutral-950 border border-white/20 rounded-xl px-4 py-3 text-lg font-medium" 
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="text-xs text-white/60 block mb-1.5">PRICE</label>
              <input type="number" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: parseFloat(e.target.value) || 0 })} className="w-full bg-neutral-950 border border-white/20 rounded-xl px-4 py-2.5" />
            </div>
            <div>
              <label className="text-xs text-white/60 block mb-1.5">STOCK / UNITS</label>
              <input type="number" value={form.inStock} onChange={(e) => setForm({ ...form, inStock: parseInt(e.target.value) || 0 })} className="w-full bg-neutral-950 border border-white/20 rounded-xl px-4 py-2.5" />
            </div>
            <div>
              <label className="text-xs text-white/60 block mb-1.5">RATING</label>
              <input type="number" step="0.1" value={form.rating} onChange={(e) => setForm({ ...form, rating: parseFloat(e.target.value) || 0 })} className="w-full bg-neutral-950 border border-white/20 rounded-xl px-4 py-2.5" />
            </div>
          </div>

          <div>
            <label className="text-xs text-white/60 block mb-1.5">DESCRIPTION</label>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={4} className="w-full bg-neutral-950 border border-white/20 rounded-2xl px-4 py-3" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-white/60 block mb-1.5">BRAND</label>
              <input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} className="w-full bg-neutral-950 border border-white/20 rounded-xl px-4 py-2.5" />
            </div>
            <div>
              <label className="text-xs text-white/60 block mb-1.5">CATEGORY</label>
              <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="w-full bg-neutral-950 border border-white/20 rounded-xl px-4 py-2.5" />
            </div>
          </div>

          {/* Full Tree Category Editor */}
          <div>
            <label className="text-xs text-white/60 block mb-2">CATEGORY & SUBCATEGORY (Full Tree Editor)</label>
            
            {categoryTree ? (
              <div className="bg-neutral-950 border border-white/20 rounded-2xl p-4 max-h-64 overflow-auto">
                {/* Root */}
                <div className="font-medium mb-2 text-white/70">{categoryTree.name}</div>

                {categoryTree.children?.map((group: any) => (
                  <details key={group.id} className="mb-2" open>
                    <summary className="cursor-pointer font-medium text-white/80 hover:text-white">
                      {group.name}
                    </summary>
                    <div className="ml-6 mt-1 space-y-1">
                      {group.children?.map((sub: any) => (
                        <div
                          key={sub.id}
                          onClick={() => handleSelectSubcategory(sub, group)}
                          className={`cursor-pointer px-3 py-1.5 rounded-xl text-sm transition-colors ${
                            selectedSubcategoryId === sub.id 
                              ? 'bg-white text-black' 
                              : 'hover:bg-white/10'
                          }`}
                        >
                          {sub.name}
                          {selectedSubcategoryId === sub.id && (
                            <span className="ml-2 text-[10px] opacity-70">(selected)</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            ) : (
              <div className="text-white/40 text-sm">Loading category tree...</div>
            )}

            {selectedCategoryPath && (
              <div className="mt-2 text-xs text-emerald-400">
                Selected: {selectedCategoryPath}
              </div>
            )}
          </div>

          <div>
            <label className="text-xs text-white/60 block mb-1.5">SUBCATEGORY (manual override)</label>
            <input value={form.subcategory} onChange={(e) => setForm({ ...form, subcategory: e.target.value })} className="w-full bg-neutral-950 border border-white/20 rounded-xl px-4 py-2.5" placeholder="e.g. Paltas" />
          </div>

          <div>
            <label className="text-xs text-white/60 block mb-1.5">IMAGES (comma separated)</label>
            <input value={form.images} onChange={(e) => setForm({ ...form, images: e.target.value })} className="w-full bg-neutral-950 border border-white/20 rounded-xl px-4 py-2.5" placeholder="/images/products/xxx.jpg" />
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.bestseller} onChange={(e) => setForm({ ...form, bestseller: e.target.checked })} className="accent-white" />
              <span className="text-sm">Bestseller</span>
            </label>
            <div>
              <label className="text-xs text-white/60 block mb-1">REVIEW COUNT</label>
              <input type="number" value={form.reviewCount} onChange={(e) => setForm({ ...form, reviewCount: parseInt(e.target.value) || 0 })} className="w-32 bg-neutral-950 border border-white/20 rounded-xl px-4 py-2" />
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-white/10 flex justify-between">
          <button onClick={() => { resetProduct(product.slug); onClose(); }} className="px-4 py-2 text-sm text-red-400 hover:text-red-300">Reset this product</button>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-6 py-2 rounded-xl border border-white/20">Cancel</button>
            <button onClick={handleSave} className="px-8 py-2 rounded-xl bg-white text-black font-medium">Save Changes</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ==================== BULK STOCK EDITOR ====================
function BulkStockEditor({ baseProducts, overrides, updateProduct }: any) {
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkValue, setBulkValue] = useState<number>(0);
  const [filter, setFilter] = useState("");

  const filteredProducts = baseProducts.filter((p: any) =>
    !filter || p.name.toLowerCase().includes(filter.toLowerCase())
  );

  const toggleSelect = (slug: string) => {
    setSelected(prev =>
      prev.includes(slug) ? prev.filter(s => s !== slug) : [...prev, slug]
    );
  };

  const selectAllVisible = () => {
    setSelected(filteredProducts.map((p: any) => p.slug));
  };

  const clearSelection = () => setSelected([]);

  const applyBulkStock = () => {
    if (selected.length === 0) return;
    if (!confirm(`Set stock to ${bulkValue} for ${selected.length} products?`)) return;

    selected.forEach(slug => {
      updateProduct(slug, { inStock: bulkValue });
    });

    alert(`Updated stock for ${selected.length} products. Remember to Publish to Database.`);
    clearSelection();
  };

  return (
    <div>
      <div className="flex flex-col md:flex-row gap-3 mb-4">
        <input
          type="text"
          placeholder="Filter products..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 bg-neutral-950 border border-white/20 rounded-xl px-4 py-2"
        />
        <button onClick={selectAllVisible} className="px-4 py-2 border border-white/20 rounded-xl text-sm">Select All Visible</button>
        <button onClick={clearSelection} className="px-4 py-2 border border-white/20 rounded-xl text-sm">Clear Selection</button>
      </div>

      <div className="flex items-center gap-3 mb-4 bg-neutral-900 p-3 rounded-2xl">
        <input
          type="number"
          value={bulkValue}
          onChange={(e) => setBulkValue(parseInt(e.target.value) || 0)}
          className="w-24 bg-neutral-950 border border-white/20 rounded-xl px-3 py-2"
          placeholder="New stock"
        />
        <button 
          onClick={applyBulkStock} 
          disabled={selected.length === 0}
          className="px-6 py-2 bg-white text-black rounded-2xl font-medium disabled:opacity-50"
        >
          Apply to {selected.length} Selected
        </button>
        <span className="text-sm text-white/60">Selected: {selected.length}</span>
      </div>

      <div className="max-h-[500px] overflow-auto border border-white/10 rounded-2xl">
        {filteredProducts.map((p: any) => {
          const currentStock = overrides[p.slug]?.inStock ?? p.inStock;
          const isSelected = selected.includes(p.slug);

          return (
            <div 
              key={p.slug} 
              onClick={() => toggleSelect(p.slug)}
              className={`flex items-center justify-between px-4 py-3 border-b border-white/10 cursor-pointer ${isSelected ? 'bg-white/10' : 'hover:bg-white/5'}`}
            >
              <div className="flex items-center gap-3">
                <input 
                  type="checkbox" 
                  checked={isSelected} 
                  onChange={() => {}} 
                  className="accent-white" 
                />
                <span>{p.name}</span>
              </div>
              <span className={currentStock === 0 ? "text-red-400" : "text-white/70"}>{currentStock} units</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ==================== CATEGORIES MANAGER (Full Tree Editor) ====================
function CategoriesManager() {
  const [tree, setTree] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [categorySearch, setCategorySearch] = useState("");

  // Rename state for tree
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renamingValue, setRenamingValue] = useState("");

  const loadTree = async () => {
    setLoading(true);
    const res = await fetch('/api/categories/tree?format=tree');
    const data = await res.json();
    if (data.success) {
      setTree(data.data.children || []); // We show Frutas + Verduras
    }
    setLoading(false);
  };

  // Simple filter for category tree
  const filterTree = (nodes: any[], search: string): any[] => {
    if (!search.trim()) return nodes;

    const lowerSearch = search.toLowerCase();

    return nodes
      .map(node => {
        const matches = node.name.toLowerCase().includes(lowerSearch);
        const filteredChildren = node.children ? filterTree(node.children, search) : [];

        if (matches || filteredChildren.length > 0) {
          return {
            ...node,
            children: filteredChildren
          };
        }
        return null;
      })
      .filter(Boolean) as any[];
  };

  const displayedTree = filterTree(tree, categorySearch);

  useEffect(() => {
    loadTree();
  }, []);

  const addSubcategory = async (parentId: number) => {
    const name = prompt("New subcategory name:");
    if (!name) return;

    await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent_id: parentId }),
    });
    loadTree();
  };

  const startRenameCategory = (id: number, currentName: string) => {
    setRenamingId(id);
    setRenamingValue(currentName);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenamingValue("");
  };

  const saveRenameCategory = async (id: number) => {
    const trimmed = renamingValue.trim();
    if (!trimmed) {
      cancelRename();
      return;
    }

    const confirmed = confirm(`Save new name "${trimmed}" for this category?`);
    if (!confirmed) {
      cancelRename();
      return;
    }

    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });

      if (res.ok) {
        cancelRename();
        await loadTree();
      } else {
        const err = await res.json().catch(() => ({}));
        if (err.error === "Database not configured" || res.status === 503) {
          alert(
            "Database not connected.\n\n" +
            "Common fix for local development:\n" +
            "1. Make sure you have POSTGRES_URL_NON_POOLING in your .env.local\n" +
            "   (Run `vercel env pull .env.local` again)\n\n" +
            "2. Or create a Postgres database in the Vercel dashboard → Storage."
          );
        } else {
          alert("Failed to rename: " + (err.error || err.message || "Unknown error"));
        }
      }
    } catch (e) {
      alert("Network error while renaming.");
    }
  };

  const deleteCategory = async (id: number, name: string) => {
    if (!confirm(`Are you sure you want to delete "${name}"?\n\nThis action cannot be undone. The category must have no subcategories.`)) return;
    await fetch(`/api/categories/${id}`, { method: 'DELETE' });
    loadTree();
  };

  const renderNode = (node: any, index?: number, parentId?: number) => (
    <div 
      key={node.id} 
      className="ml-4 border-l border-white/10 pl-4 py-1"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", JSON.stringify({ id: node.id, parent_id: parentId }));
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const data = JSON.parse(e.dataTransfer.getData("text/plain"));
        // Basic console log for now - full implementation would call API to update sort_order/parent
        console.log("Dropped", data.id, "onto", node.id);
        alert("Drag & drop reordering detected. Full save to database coming in next iteration.");
      }}
    >
      <div className="flex items-center gap-2 group cursor-grab active:cursor-grabbing">
        {renamingId === node.id ? (
          <>
            <input
              value={renamingValue}
              onChange={(e) => setRenamingValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveRenameCategory(node.id);
                if (e.key === 'Escape') cancelRename();
              }}
              className="flex-1 bg-neutral-800 border border-white/30 rounded px-2 py-1 text-sm"
              autoFocus
            />
            <button 
              onClick={() => saveRenameCategory(node.id)} 
              className="text-xs px-3 py-1 bg-emerald-600 rounded text-white"
            >
              Save
            </button>
            <button 
              onClick={cancelRename} 
              className="text-xs px-3 py-1 border border-white/20 rounded"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <span className="font-medium">↕ {node.name}</span>
            
            <button 
              onClick={() => startRenameCategory(node.id, node.name)}
              className="text-xs px-2 py-0.5 opacity-60 hover:opacity-100 border border-white/20 rounded"
            >
              Rename
            </button>

            {node.isLeaf && (
              <button 
                onClick={() => deleteCategory(node.id, node.name)}
                className="text-xs px-2 py-0.5 text-red-400 opacity-60 hover:opacity-100"
              >
                Delete
              </button>
            )}

            <button 
              onClick={() => addSubcategory(node.id)}
              className="text-xs px-2 py-0.5 bg-white/10 rounded hover:bg-white/20"
            >
              + Add Sub
            </button>
          </>
        )}
      </div>

      {node.children && node.children.length > 0 && (
        <div className="mt-1">
          {node.children.map((child: any, idx: number) => renderNode(child, idx, node.id))}
        </div>
      )}
    </div>
  );

  if (loading) return <div className="p-8">Loading categories...</div>;

  return (
    <div className="bg-neutral-900 border border-white/10 rounded-3xl p-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <h2 className="text-2xl font-semibold">Categories Tree Editor</h2>
        
        <div className="flex gap-3">
          <input
            type="text"
            value={categorySearch}
            onChange={(e) => setCategorySearch(e.target.value)}
            placeholder="Search categories..."
            className="bg-neutral-950 border border-white/20 rounded-xl px-4 py-2 text-sm w-64"
          />
          <button onClick={loadTree} className="text-sm px-4 py-2 border border-white/20 rounded-xl">Refresh</button>
        </div>
      </div>

      <div className="space-y-4">
        {displayedTree.map((group: any) => (
          <div key={group.id} className="border border-white/10 rounded-2xl p-4">
            <div className="font-semibold text-lg mb-3 flex items-center justify-between">
              <span>{group.name}</span>
              <button 
                onClick={() => addSubcategory(group.id)}
                className="text-sm px-4 py-1 bg-white/10 rounded-xl hover:bg-white/20"
              >
                + Add Subcategory
              </button>
            </div>
            <div className="pl-2">
              {group.children?.map((child: any) => renderNode(child))}
            </div>
          </div>
        ))}
        {displayedTree.length === 0 && categorySearch && (
          <div className="text-white/50 italic">No categories match your search.</div>
        )}
      </div>

      <p className="mt-6 text-xs text-white/50">
        Click <strong>Rename</strong> to edit names. Use <strong>+ Add Sub</strong> to create new items. Delete only works on leaf nodes.
      </p>
    </div>
  );
}

// ==================== BRANDS MANAGER COMPONENT ====================
function BrandsManager() {
  const [brands, setBrands] = useState<any[]>([]);
  const [newBrandName, setNewBrandName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState("");

  const loadBrands = async () => {
    const res = await fetch('/api/brands');
    const data = await res.json();
    if (data.success) setBrands(data.data);
  };

  useEffect(() => {
    loadBrands();
  }, []);

  const addBrand = async () => {
    if (!newBrandName.trim()) return;
    await fetch('/api/brands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newBrandName.trim() }),
    });
    setNewBrandName("");
    loadBrands();
  };

  const startEdit = (brand: any) => {
    setEditingId(brand.id);
    setEditingName(brand.name);
  };

  const saveEdit = async (id: number, oldName: string) => {
    const newName = editingName.trim();
    if (!newName || newName === oldName) {
      setEditingId(null);
      return;
    }

    if (!confirm(`Save rename from "${oldName}" to "${newName}"?`)) {
      setEditingId(null);
      return;
    }

    await fetch(`/api/brands/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    setEditingId(null);
    loadBrands();
  };

  const deleteBrand = async (id: number, name: string) => {
    if (!confirm(`Are you sure you want to delete the brand "${name}"?`)) return;
    await fetch(`/api/brands/${id}`, { method: 'DELETE' });
    loadBrands();
  };

  return (
    <div className="bg-neutral-900 border border-white/10 rounded-3xl p-8">
      <h2 className="text-2xl font-semibold mb-6">Brands Management</h2>

      {/* Add new brand */}
      <div className="flex gap-3 mb-8">
        <input
          value={newBrandName}
          onChange={(e) => setNewBrandName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addBrand()}
          placeholder="New brand name"
          className="flex-1 bg-neutral-950 border border-white/20 rounded-2xl px-5 py-3"
        />
        <button onClick={addBrand} className="px-6 py-3 bg-white text-black rounded-2xl font-medium">Add Brand</button>
      </div>

      <div className="space-y-2">
        {brands.map(brand => (
          <div key={brand.id} className="flex items-center gap-3 border border-white/10 rounded-2xl px-4 py-3">
            {editingId === brand.id ? (
              <>
                <input
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveEdit(brand.id, brand.name)}
                  className="flex-1 bg-neutral-950 border border-white/20 rounded-xl px-4 py-2"
                  autoFocus
                />
                <button onClick={() => saveEdit(brand.id, brand.name)} className="px-4 py-2 bg-emerald-600 rounded-xl text-sm">Save</button>
                <button onClick={() => setEditingId(null)} className="px-4 py-2 border border-white/20 rounded-xl text-sm">Cancel</button>
              </>
            ) : (
              <>
                <div className="flex-1 font-medium">{brand.name}</div>
                <button onClick={() => startEdit(brand)} className="px-4 py-1.5 text-sm border border-white/20 rounded-xl hover:bg-white/5">Rename</button>
                <button onClick={() => deleteBrand(brand.id, brand.name)} className="px-4 py-1.5 text-sm text-red-400 border border-red-500/30 rounded-xl hover:bg-red-950/50">Delete</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AdminPage() {
  const { 
    overrides, 
    updateProduct, 
    resetProduct, 
    resetAll, 
    loadFromDatabase, 
    isLoadedFromDB,
    migrateLocalChangesToDatabase 
  } = useAdminProductStore();

  // Auth
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [password, setPassword] = useState("");

  // Sections
  const [activeSection, setActiveSection] = useState<Section>("products");

  // Search
  const [globalSearch, setGlobalSearch] = useState("");
  const [productSearch, setProductSearch] = useState("");

  // Modals & Status
  const [editingProduct, setEditingProduct] = useState<any>(null);
  const [publishStatus, setPublishStatus] = useState<"idle" | "publishing" | "success" | "error">("idle");
  const [publishMessage, setPublishMessage] = useState("");
  const [migrationStatus, setMigrationStatus] = useState<"idle" | "migrating" | "success" | "error">("idle");
  const [migrationMessage, setMigrationMessage] = useState("");

  // Command bar - typing switches sections
  const handleGlobalSearch = (value: string) => {
    setGlobalSearch(value);
    const lower = value.toLowerCase().trim();

    if (lower.includes("product")) setActiveSection("products");
    else if (lower.includes("brand")) setActiveSection("brands");
    else if (lower.includes("categor")) setActiveSection("categories");
    else if (lower.includes("stock") || lower.includes("unit")) setActiveSection("stock");
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (password === "umantai" || password === "admin") {
      setIsAuthenticated(true);
      loadFromDatabase();
    } else {
      alert("Wrong password. Try 'umantai'");
    }
  };

  const handlePublish = async () => {
    setPublishStatus("publishing");
    try {
      const res = await fetch("/api/admin/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides }),
      });
      const data = await res.json();
      if (res.ok) {
        setPublishStatus("success");
        setPublishMessage("Published successfully to Vercel Postgres!");
        await loadFromDatabase();
      } else {
        throw new Error(data.error || "Failed");
      }
    } catch (e) {
      setPublishStatus("error");
      setPublishMessage(
        "Publish failed. Make sure you have a working Vercel Postgres connection " +
        "(POSTGRES_URL_NON_POOLING is recommended for local dev)."
      );
    }
    setTimeout(() => { setPublishStatus("idle"); setPublishMessage(""); }, 3500);
  };

  const handleMigrate = async () => {
    setMigrationStatus("migrating");
    const result = await migrateLocalChangesToDatabase();
    if (result.success) {
      setMigrationStatus("success");
      setMigrationMessage(result.message || "Migration successful!");
      await loadFromDatabase();
    } else {
      setMigrationStatus("error");
      setMigrationMessage(
        (result.message || "Migration failed.") +
        "\n\nTip: Use POSTGRES_URL_NON_POOLING in .env.local for reliable local connections."
      );
    }
    setTimeout(() => { setMigrationStatus("idle"); setMigrationMessage(""); }, 4000);
  };

  // Filtered products for the Products tab
  const filteredProducts = baseProducts.filter(p => 
    !productSearch || 
    p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
    p.brand.toLowerCase().includes(productSearch.toLowerCase()) ||
    (p.subcategory && p.subcategory.toLowerCase().includes(productSearch.toLowerCase()))
  );

  // Simple brands list (from current data + overrides)
  const currentBrands = Array.from(new Set(baseProducts.map(p => p.brand)));

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white flex items-center justify-center">
        <div className="max-w-md w-full px-8">
          <div className="text-center mb-8">
            <div className="text-4xl font-semibold tracking-tighter mb-2">umantai</div>
            <div className="text-white/60">Admin Panel</div>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter admin password" className="w-full bg-neutral-900 border border-white/20 rounded-xl px-4 py-3 text-lg" autoFocus />
            <button type="submit" className="w-full py-3 bg-white text-black rounded-xl font-medium">Enter Admin</button>
          </form>
          <p className="text-center text-white/40 text-sm mt-6">Password: <span className="font-mono">umantai</span></p>
        </div>
      </div>
    );
  }

  const hasLocalChanges = Object.keys(overrides).length > 0;

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Header */}
      <div className="border-b border-white/10 bg-neutral-950/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="font-semibold text-2xl tracking-[-1px]">umantai</Link>
            <div className="text-sm px-3 py-1 rounded-full bg-white/10 text-white/80">Backend</div>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/products" className="text-sm text-white/70 hover:text-white">View Store →</Link>
            <button onClick={resetAll} disabled={!hasLocalChanges} className="px-4 py-2 text-sm rounded-lg border border-white/20 disabled:opacity-40">Reset All</button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <h1 className="text-4xl tracking-tighter font-semibold mb-2">Backend Management</h1>
        <p className="text-white/60 mb-6">Type in the bar below to switch sections (products, brands, categories, stock)</p>

        {/* Command / Global Search Bar */}
        <div className="mb-8">
          <input
            type="text"
            value={globalSearch}
            onChange={(e) => handleGlobalSearch(e.target.value)}
            placeholder="Type: products, brands, categories, stock, units..."
            className="w-full bg-neutral-900 border border-white/20 rounded-2xl px-6 py-4 text-lg focus:outline-none focus:border-white/40"
          />
        </div>

        {/* Section Tabs */}
        <div className="flex gap-2 mb-8 border-b border-white/10 pb-4 flex-wrap">
          {(["products", "brands", "categories", "stock"] as Section[]).map(sec => (
            <button
              key={sec}
              onClick={() => setActiveSection(sec)}
              className={`px-5 py-2 rounded-2xl text-sm font-medium capitalize transition-all ${activeSection === sec ? "bg-white text-black" : "bg-neutral-900 border border-white/20 hover:bg-white/5"}`}
            >
              {sec}
            </button>
          ))}
        </div>

        {/* Database Actions Bar */}
        <div className="mb-8 rounded-3xl border border-white/10 bg-neutral-900 p-6">
          <div className="flex flex-col lg:flex-row gap-4 lg:items-center justify-between">
            <div>
              <div className="font-semibold">Vercel Postgres • Published Data</div>
              <div className="text-sm text-white/60">Changes survive deployments when published here.</div>
            </div>
            <div className="flex flex-wrap gap-3">
              <button onClick={handleMigrate} disabled={!hasLocalChanges || migrationStatus === "migrating"} className="px-5 py-2 rounded-2xl border border-amber-500/40 text-amber-300 text-sm disabled:opacity-50">Migrate local changes to DB</button>
              <button onClick={() => loadFromDatabase()} className="px-5 py-2 rounded-2xl border border-white/20 text-sm">Reload from DB</button>
              <button onClick={handlePublish} disabled={!hasLocalChanges || publishStatus === "publishing"} className="px-8 py-2 rounded-2xl bg-white text-black font-medium disabled:bg-white/60">Publish to Database</button>
            </div>
          </div>
          {(publishMessage || migrationMessage) && (
            <div className="mt-4 text-sm text-emerald-300">{publishMessage || migrationMessage}</div>
          )}
        </div>

        {/* === SECTIONS === */}

        {/* PRODUCTS */}
        {activeSection === "products" && (
          <div>
            <div className="mb-4 flex items-center gap-4">
              <input
                type="text"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="Filter products by name, brand, or category..."
                className="flex-1 bg-neutral-900 border border-white/20 rounded-2xl px-5 py-3 text-sm"
              />
            </div>

            <div className="bg-neutral-900 border border-white/10 rounded-3xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b border-white/10 bg-neutral-950">
                  <tr className="text-left text-white/60">
                    <th className="py-4 px-6">Product</th>
                    <th className="py-4 px-6">Price</th>
                    <th className="py-4 px-6">Stock / Units</th>
                    <th className="py-4 px-6">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {filteredProducts.map(product => {
                    const ov = overrides[product.slug] || {};
                    const price = ov.price ?? product.price;
                    const stock = ov.inStock ?? product.inStock;
                    const modified = Object.keys(ov).length > 0;

                    return (
                      <tr key={product.slug}>
                        <td className="py-4 px-6">
                          <div className="font-medium">{product.name}</div>
                          <div className="text-xs text-white/50">{product.brand} • {product.subcategory}</div>
                        </td>
                        <td className="py-4 px-6 font-mono">${price}</td>
                        <td className="py-4 px-6"><span className={stock === 0 ? "text-red-400" : ""}>{stock}</span></td>
                        <td className="py-4 px-6">
                          <div className="flex gap-2">
                            <button onClick={() => setEditingProduct(product)} className="px-4 py-1 text-xs border border-white/20 rounded-lg hover:bg-white/5">Edit</button>
                            <button onClick={() => updateProduct(product.slug, { inStock: 0 })} className="px-3 py-1 text-xs border border-red-500/30 text-red-400 rounded-lg">Hide</button>
                            {modified && <button onClick={() => resetProduct(product.slug)} className="px-3 py-1 text-xs border border-white/20 rounded-lg">Reset</button>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* BRANDS - Fully Editable */}
        {activeSection === "brands" && (
          <BrandsManager />
        )}

        {/* CATEGORIES - Full Tree Editor */}
        {activeSection === "categories" && (
          <CategoriesManager />
        )}

        {/* STOCK / UNITS - with Bulk Editing */}
        {activeSection === "stock" && (
          <div>
            <h2 className="text-2xl font-semibold mb-4">Stock / Units - Bulk Editor</h2>
            
            <BulkStockEditor 
              baseProducts={baseProducts} 
              overrides={overrides} 
              updateProduct={updateProduct} 
            />
          </div>
        )}
      </div>

      {editingProduct && <EditModal product={editingProduct} onClose={() => setEditingProduct(null)} />}
    </div>
  );
}
