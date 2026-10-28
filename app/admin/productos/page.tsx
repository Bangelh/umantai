"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { baseProducts } from "@/lib/products";
import { useAdminProductStore, ProductOverride } from "@/lib/adminProductStore";
import { wholeFoodsCategories } from "@/lib/categories";
import { EnvironmentStatus } from "../components/EnvironmentStatus";
import { AdminNav } from "../components/AdminNav";
import { withAdminAuth } from "@/lib/adminAuth";
import { formatMoneyUnits } from "@/lib/format";
import { AdminAccessScreen } from "@/components/admin/AdminAccessScreen";
import { usePlatformAdminSession } from "@/lib/usePlatformAdminSession";

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
      await fetch(`/api/products/${product.slug}`, withAdminAuth({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload),
      }));
    } catch (error) {
      console.error("Failed to persist product edit (rename/stock/category) to database", error);
      alert(
        "Edit saved locally (preview) but failed to save to database.\n\n" +
        "Tip: For local development, use POSTGRES_URL_NON_POOLING in .env.local " +
        "(run `vercel env pull .env.local` to get the latest vars). Then use Publish or Migrate."
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
              <div className="text-sm text-tertiary">Cargando categorías…</div>
            )}

            {selectedCategoryPath && (
              <div className="mt-2 text-xs text-emerald-400">
                Seleccionado: {selectedCategoryPath}
              </div>
            )}
          </div>

          <div>
            <label className="text-xs text-white/60 block mb-1.5">SUBCATEGORY (manual override)</label>
            <input value={form.subcategory} onChange={(e) => setForm({ ...form, subcategory: e.target.value })} className="w-full bg-neutral-950 border border-white/20 rounded-xl px-4 py-2.5" placeholder="Ej. Paltas" />
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
            <button onClick={onClose} className="h-11 rounded-xl border border-border-strong px-6">Cancelar</button>
            <button onClick={handleSave} className="h-11 rounded-xl bg-brand px-8 font-medium text-background">Guardar cambios</button>
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

    alert(`Stock actualizado en ${selected.length} productos. Recuerda publicar los cambios.`);
    clearSelection();
  };

  return (
    <div>
      <div className="flex flex-col md:flex-row gap-3 mb-4">
        <input
          type="text"
          placeholder="Filtrar productos…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="field-input h-11 flex-1"
        />
        <button onClick={selectAllVisible} className="h-11 rounded-xl border border-border-strong px-4 text-sm">Seleccionar los visibles</button>
        <button onClick={clearSelection} className="h-11 rounded-xl border border-border-strong px-4 text-sm">Limpiar selección</button>
      </div>

      <div className="flex items-center gap-3 mb-4 bg-neutral-900 p-3 rounded-2xl">
        <input
          type="number"
          value={bulkValue}
          onChange={(e) => setBulkValue(parseInt(e.target.value) || 0)}
          className="field-input h-11 w-28"
          placeholder="Nuevo stock"
          aria-label="Nuevo stock para los productos seleccionados"
        />
        <button 
          onClick={applyBulkStock} 
          disabled={selected.length === 0}
          className="btn-primary h-11 disabled:opacity-50"
        >
          Aplicar a {selected.length} seleccionados
        </button>
        <span className="text-sm text-tertiary">Seleccionados: {selected.length}</span>
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
    // Use DB-backed endpoint so renames + adds via PATCH/POST are immediately visible in the editor UI.
    // Falls back gracefully if DB empty (user can seed below).
    const res = await fetch('/api/categories?format=tree');
    const data = await res.json();
    if (data.success) {
      setTree(data.data || []); // DB format=tree returns roots array directly (Frutas/Verduras groups)
    } else {
      // If DB not ready or error, try the static tree as last resort (for display only)
      try {
        const res2 = await fetch('/api/categories/tree');
        const data2 = await res2.json();
        if (data2.success) setTree(data2.data?.children || []);
      } catch {}
    }
    setLoading(false);
  };

  const seedCategoriesFromStatic = async () => {
    if (!confirm('Initialize DB categories from the static Whole Foods list?\n\nThis will create top-level groups (Frutas, Verduras) + all subcategories. Existing DB categories will remain (duplicates may error).')) return;

    const groups = wholeFoodsCategories.subcategories || [];
    for (const group of groups) {
      // Create group as top-level (parent_id null)
      const groupRes = await fetch('/api/categories', withAdminAuth({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: group.name }),
      }));
      const groupData = await groupRes.json().catch(() => ({}));
      const parentId = groupData?.data?.id;
      if (!parentId) {
        console.warn('Failed to create group', group.name, groupData);
        continue;
      }
      // Create subs under it
      for (const sub of (group.subcategories || [])) {
        await fetch('/api/categories', withAdminAuth({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: sub.name, parent_id: parentId }),
        })).catch(() => {});
      }
    }
    await loadTree();
    alert('Seeded categories from static list. You can now Rename items and they will persist + reflect here.');
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

    await fetch('/api/categories', withAdminAuth({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent_id: parentId }),
    }));
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
      const res = await fetch(`/api/categories/${id}`, withAdminAuth({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      }));

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
          alert("No se pudo renombrar: " + (err.error || err.message || "error desconocido"));
        }
      }
    } catch (e) {
      alert("Error de red al renombrar.");
    }
  };

  const deleteCategory = async (id: number, name: string) => {
    if (!confirm(`¿Eliminar la categoría "${name}"?\n\nNo se puede deshacer y la categoría debe estar vacía.`)) return;
    await fetch(`/api/categories/${id}`, withAdminAuth({ method: 'DELETE' }));
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

  if (loading) return <div className="p-8 text-[15px] text-tertiary">Cargando categorías…</div>;

  return (
    <div className="bg-neutral-900 border border-white/10 rounded-3xl p-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <h2 className="text-2xl font-semibold">Categories Tree Editor</h2>
        
        <div className="flex gap-3 flex-wrap">
          <input
            type="text"
            value={categorySearch}
            onChange={(e) => setCategorySearch(e.target.value)}
            placeholder="Buscar categorías…"
            className="bg-neutral-950 border border-white/20 rounded-xl px-4 py-2 text-sm w-64"
          />
          <button onClick={loadTree} className="text-sm px-4 py-2 border border-white/20 rounded-xl">Refresh</button>
          <button 
            onClick={seedCategoriesFromStatic} 
            className="text-sm px-4 py-2 bg-emerald-600/90 hover:bg-emerald-600 rounded-xl"
            title="One-time: populate the categories table from the built-in Whole Foods list so rename/save works immediately"
          >
            Seed from static
          </button>
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
          <div className="text-[15px] text-tertiary italic">Ninguna categoría coincide con la búsqueda.</div>
        )}
      </div>

      <p className="mt-6 text-xs text-white/50">
        Click <strong>Rename</strong> to edit names (persisted to DB + live in this tree after refresh). Use <strong>Seed from static</strong> first if tree is empty. <strong>+ Add Sub</strong> to create new items. Delete only works on leaf nodes.
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
    await fetch('/api/brands', withAdminAuth({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newBrandName.trim() }),
    }));
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

    await fetch(`/api/brands/${id}`, withAdminAuth({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    }));
    setEditingId(null);
    loadBrands();
  };

  const deleteBrand = async (id: number, name: string) => {
    if (!confirm(`¿Eliminar la marca "${name}"? No se puede deshacer.`)) return;
    await fetch(`/api/brands/${id}`, withAdminAuth({ method: 'DELETE' }));
    loadBrands();
  };

  return (
    <div className="mt-6 rounded-2xl border border-border bg-surface p-5">
      <h2 className="text-xl font-semibold">Marcas</h2>

      {/* Add new brand */}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input
          value={newBrandName}
          onChange={(e) => setNewBrandName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addBrand()}
          placeholder="Nombre de la marca"
          aria-label="Nombre de la nueva marca"
          className="field-input h-11 flex-1"
        />
        <button onClick={addBrand} className="btn-primary h-11">Agregar marca</button>
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
                  className="field-input h-11 flex-1"
                  autoFocus
                />
                <button onClick={() => saveEdit(brand.id, brand.name)} className="h-11 rounded-xl bg-success px-4 text-sm font-semibold text-background">Guardar</button>
                <button onClick={() => setEditingId(null)} className="h-11 rounded-xl border border-border-strong px-4 text-sm">Cancelar</button>
              </>
            ) : (
              <>
                <div className="flex-1 font-medium">{brand.name}</div>
                <button onClick={() => startEdit(brand)} className="h-11 rounded-xl border border-border-strong px-4 text-sm hover:bg-surface-raised">Renombrar</button>
                <button onClick={() => deleteBrand(brand.id, brand.name)} className="h-11 rounded-xl border border-destructive/40 px-4 text-sm text-destructive hover:bg-destructive/10">Eliminar</button>
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

  // Auth — sesión de Platform Admin (sin token manual en la UI).
  const admin = usePlatformAdminSession();

  // Sections
  const [activeSection, setActiveSection] = useState<Section>("products");

  // Search
  const [productSearch, setProductSearch] = useState("");

  // Modals & Status
  const [editingProduct, setEditingProduct] = useState<any>(null);
  const [publishStatus, setPublishStatus] = useState<"idle" | "publishing" | "success" | "error">("idle");
  const [publishMessage, setPublishMessage] = useState("");
  const [migrationStatus, setMigrationStatus] = useState<"idle" | "migrating" | "success" | "error">("idle");
  const [migrationMessage, setMigrationMessage] = useState("");
  const [setupStatus, setSetupStatus] = useState<"idle" | "running" | "success" | "error">("idle");
  const [setupMessage, setSetupMessage] = useState("");

  // Cuando la sesión de admin queda activa, se carga la base una sola vez.
  useEffect(() => {
    if (admin.status === 'authenticated') void loadFromDatabase();
  }, [admin.status, loadFromDatabase]);

  const handlePublish = async () => {
    setPublishStatus("publishing");
    try {
      const res = await fetch("/api/admin/overrides", withAdminAuth({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides }),
      }));
      const data = await res.json();
      if (res.ok) {
        setPublishStatus("success");
        setPublishMessage("Cambios publicados.");
        await loadFromDatabase();
      } else {
        throw new Error(data.error || "Failed");
      }
    } catch (e) {
      setPublishStatus("error");
      setPublishMessage("No se pudo publicar. Revisa la conexión a la base en Herramientas técnicas.");
    }
    setTimeout(() => { setPublishStatus("idle"); setPublishMessage(""); }, 3500);
  };

  const handleMigrate = async () => {
    setMigrationStatus("migrating");
    const result = await migrateLocalChangesToDatabase();
    if (result.success) {
      setMigrationStatus("success");
      setMigrationMessage(result.message || "Migración completada.");
      await loadFromDatabase();
    } else {
      setMigrationStatus("error");
      setMigrationMessage(result.message || "La migración falló.");
    }
    setTimeout(() => { setMigrationStatus("idle"); setMigrationMessage(""); }, 4000);
  };

  const handleSetupDb = async () => {
    setSetupStatus("running");
    setSetupMessage("");
    try {
      const res = await fetch("/api/admin/setup-db", withAdminAuth({ method: "POST" }));
      const data = await res.json();
      if (res.ok && data.success) {
        setSetupStatus("success");
        setSetupMessage(data.message || "Tablas base creadas.");
      } else {
        throw new Error(data.error || data.message || "Falló la creación de tablas");
      }
    } catch (e: any) {
      setSetupStatus("error");
      setSetupMessage("Falló la creación de tablas: " + (e?.message || "revisa la conexión a la base."));
    }
    setTimeout(() => { setSetupStatus("idle"); setSetupMessage(""); }, 6000);
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

  if (admin.status !== 'authenticated') {
    return (
      <AdminAccessScreen
        title="Backend"
        status={admin.status}
        onActivate={admin.activate}
      />
    );
  }

  const hasLocalChanges = Object.keys(overrides).length > 0;

  const SECTION_LABELS: Record<Section, string> = {
    products: "Productos",
    brands: "Marcas",
    categories: "Categorías",
    stock: "Stock por unidad",
  };

  return (
    <div className="min-h-screen bg-background text-primary">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <nav className="flex flex-wrap items-center gap-2 text-sm text-tertiary" aria-label="Ruta">
          <Link href="/admin" className="hover:text-primary">Panel</Link>
          <span aria-hidden="true">/</span>
          <span className="text-secondary">Catálogo del sitio</span>
        </nav>

        <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[2px] text-muted">CATÁLOGO</p>
            <h1 className="mt-1 text-title font-semibold">Catálogo del sitio</h1>
            <p className="mt-1 max-w-2xl text-body text-secondary">
              Precios, stock y categorías del catálogo base del sitio. Los productos de
              cada comercio se administran en{' '}
              <Link href="/admin/catalogo" className="underline underline-offset-4 hover:text-primary">
                Catálogo maestro
              </Link>{' '}
              y en el panel del comerciante.
            </p>
          </div>
          <button
            onClick={resetAll}
            disabled={!hasLocalChanges}
            className="btn-secondary h-11 text-sm disabled:opacity-40"
          >
            Descartar cambios locales
          </button>
        </header>

        <div className="mt-4 overflow-x-auto">
          <AdminNav />
        </div>

        <div className="mt-5 rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
          Este editor trabaja sobre el catálogo base del sitio, no sobre las tiendas del
          marketplace. Un cambio acá no crea ni modifica productos de un comercio.
        </div>

        {/* Secciones: botones grandes, sin barra de comandos críptica. */}
        <div className="mt-5 flex flex-wrap gap-2 border-b border-border pb-3" role="tablist" aria-label="Secciones del catálogo">
          {(["products", "brands", "categories", "stock"] as Section[]).map(sec => (
            <button
              key={sec}
              role="tab"
              aria-selected={activeSection === sec}
              onClick={() => setActiveSection(sec)}
              className={`h-11 rounded-full px-5 text-[15px] font-medium transition-colors ${
                activeSection === sec
                  ? "bg-brand text-background"
                  : "border border-border-strong text-secondary hover:bg-surface-raised hover:text-primary"
              }`}
            >
              {SECTION_LABELS[sec]}
            </button>
          ))}
        </div>

        {/* Publicar: la acción principal, una sola vez y con estado claro. */}
        <div className="mt-5 flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-body font-semibold">
              {hasLocalChanges
                ? "Hay cambios sin publicar"
                : "Sin cambios pendientes"}
            </p>
            <p className="mt-0.5 text-sm text-tertiary">
              Publicar guarda estos cambios en la base del sitio.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => loadFromDatabase()} className="btn-secondary h-11 text-sm">
              Recargar
            </button>
            <button
              onClick={handlePublish}
              disabled={!hasLocalChanges || publishStatus === "publishing"}
              className="btn-primary h-11 disabled:opacity-50"
            >
              {publishStatus === "publishing" ? "Publicando…" : "Publicar cambios"}
            </button>
          </div>
        </div>

        {(publishMessage || migrationMessage || setupMessage) && (
          <p
            role="status"
            className={`mt-3 rounded-xl border px-4 py-3 text-sm ${
              publishStatus === "error" || migrationStatus === "error" || setupStatus === "error"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-success/40 bg-success/10 text-success"
            }`}
          >
            {publishMessage || migrationMessage || setupMessage}
          </p>
        )}

        {/* Herramientas técnicas: plegadas. Un operador no las necesita a la vista. */}
        <details className="mt-5 rounded-2xl border border-border bg-surface p-4">
          <summary className="cursor-pointer text-sm font-medium text-secondary">
            Herramientas técnicas (conexión y migración)
          </summary>
          <div className="mt-4 space-y-4">
            <EnvironmentStatus />
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleSetupDb}
                disabled={setupStatus === "running"}
                className="btn-secondary h-11 text-sm disabled:opacity-50"
              >
                Crear tablas base
              </button>
              <button
                onClick={handleMigrate}
                disabled={!hasLocalChanges || migrationStatus === "migrating"}
                className="btn-secondary h-11 text-sm disabled:opacity-50"
              >
                Migrar cambios locales
              </button>
            </div>
          </div>
        </details>

        {/* === SECTIONS === */}

        {/* PRODUCTS */}
        {activeSection === "products" && (
          <div className="mt-6">
            <label className="field-label" htmlFor="product-filter">
              Buscar producto
            </label>
            <input
              id="product-filter"
              type="search"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder="Nombre, marca o categoría"
              className="field-input h-11 max-w-md"
            />

            <div className="mt-4 overflow-x-auto rounded-2xl border border-border bg-surface">
              <table className="w-full min-w-[680px] text-[15px]">
                <thead className="border-b border-border bg-surface-raised text-left text-[13px] uppercase tracking-wide text-tertiary">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-semibold">Producto</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Precio</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Stock</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredProducts.map(product => {
                    const ov = overrides[product.slug] || {};
                    const effective = { ...product, ...ov };
                    const price = effective.price;
                    const stock = effective.inStock;
                    const modified = Object.keys(ov).length > 0;

                    return (
                      <tr key={product.slug}>
                        <td className="px-4 py-3">
                          <div className="font-medium">{effective.name}</div>
                          <div className="text-[13px] text-tertiary">
                            {effective.brand} · {effective.subcategory}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono tabular-nums">
                          {formatMoneyUnits(Number(price) || 0, "USD")}
                        </td>
                        <td className="px-4 py-3 font-mono tabular-nums">
                          <span className={stock === 0 ? "font-semibold text-destructive" : ""}>{stock}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() => setEditingProduct(product)}
                              className="h-11 rounded-xl border border-border-strong px-3 text-sm hover:bg-surface-raised"
                            >
                              Editar
                            </button>
                            <button
                              onClick={() => {
                                if (stock === 0) return;
                                if (confirm(`¿Ocultar ${effective.name}? Se queda sin stock y deja de ofrecerse.`)) {
                                  updateProduct(product.slug, { inStock: 0 });
                                }
                              }}
                              disabled={stock === 0}
                              className="h-11 rounded-xl border border-destructive/40 px-3 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-40"
                            >
                              Ocultar
                            </button>
                            {modified && (
                              <button
                                onClick={() => resetProduct(product.slug)}
                                className="h-11 rounded-xl border border-border-strong px-3 text-sm hover:bg-surface-raised"
                              >
                                Restablecer
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredProducts.length === 0 && (
                <p className="px-4 py-8 text-center text-[15px] text-tertiary">
                  No hay productos que coincidan con la búsqueda.
                </p>
              )}
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
          <div className="mt-6">
            <h2 className="text-xl font-semibold">Stock por unidad</h2>
            <p className="mt-1 text-[15px] text-secondary">
              Cambia el stock de varios productos a la vez. Después publica los cambios.
            </p>
            
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
