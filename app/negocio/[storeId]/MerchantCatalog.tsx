'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  cartesianVariants,
  parseVariantAxesInput,
  type CatalogVariant,
  type ProductOptionSchema,
} from '@/lib/catalog';

interface MerchantProduct {
  id: string;
  slug: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  imageUrl: string | null;
  priceCents: number;
  currency: string;
  unit: string;
  visible: boolean;
  available: number;
  optionSchema: ProductOptionSchema[];
  variants: CatalogVariant[];
}

interface VariantDraft {
  optionValues: Record<string, string>;
  sku: string;
  price: string;
  stock: string;
}

interface MasterHit {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  imageUrl: string | null;
}

function money(cents: number, currency = 'PEN') {
  return new Intl.NumberFormat('es-PE', { style: 'currency', currency }).format(cents / 100);
}

function buildVariants(axes: string): VariantDraft[] {
  try {
    const schema = parseVariantAxesInput(axes);
    return cartesianVariants(schema).map((optionValues) => ({
      optionValues,
      sku: '',
      price: '',
      stock: '0',
    }));
  } catch {
    return [];
  }
}

export function MerchantCatalog({
  storeId,
  products,
}: {
  storeId: string;
  products: MerchantProduct[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [mode, setMode] = useState<'own' | 'master' | null>(null);
  const [busy, setBusy] = useState(false);

  const [masterQuery, setMasterQuery] = useState('');
  const [masterHits, setMasterHits] = useState<MasterHit[]>([]);
  const [master, setMaster] = useState<MasterHit | null>(null);

  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [brand, setBrand] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [unit, setUnit] = useState('unidad');
  const [stock, setStock] = useState('0');
  const [axes, setAxes] = useState('');
  const [variantDrafts, setVariantDrafts] = useState<VariantDraft[]>([]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPrice, setEditPrice] = useState('');
  const [editName, setEditName] = useState('');
  const [stockProductId, setStockProductId] = useState<string | null>(null);
  const [stockVariantKey, setStockVariantKey] = useState('');
  const [stockDelta, setStockDelta] = useState('');
  const [stockReason, setStockReason] = useState('Ajuste de inventario');
  const [variantProductId, setVariantProductId] = useState<string | null>(null);
  const [variantAxes, setVariantAxes] = useState('talla:M,L');
  const [variantSku, setVariantSku] = useState('');
  const [variantPrice, setVariantPrice] = useState('');
  const [variantStock, setVariantStock] = useState('0');
  const [variantEdit, setVariantEdit] = useState<{
    variantId: string;
    sku: string;
    price: string;
  } | null>(null);

  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const logoInput = useRef<HTMLInputElement | null>(null);

  const categories = useMemo(
    () =>
      [...new Set(products.map((product) => product.category).filter(Boolean))].sort((a, b) =>
        String(a).localeCompare(String(b), 'es'),
      ) as string[],
    [products],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((product) => {
      if (categoryFilter && product.category !== categoryFilter) return false;
      if (!q) return true;
      return [product.name, product.brand, product.category, product.slug]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [products, query, categoryFilter]);

  const resetForm = () => {
    setName('');
    setCategory('');
    setBrand('');
    setDescription('');
    setPrice('');
    setUnit('unidad');
    setStock('0');
    setAxes('');
    setVariantDrafts([]);
    setMaster(null);
    setMasterQuery('');
    setMasterHits([]);
  };

  const openOwn = () => {
    resetForm();
    setMode('own');
  };

  const openMaster = () => {
    resetForm();
    setMode('master');
  };

  const searchMaster = async () => {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/merchant/master-products?q=${encodeURIComponent(masterQuery)}&limit=20`,
      );
      const payload = (await response.json().catch(() => null)) as { products?: MasterHit[]; error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'No se pudo buscar.');
      setMasterHits(payload?.products ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo buscar.');
    } finally {
      setBusy(false);
    }
  };

  const chooseMaster = (hit: MasterHit) => {
    setMaster(hit);
    setName(hit.name);
    setCategory(hit.category ?? '');
    setBrand(hit.brand ?? '');
    setDescription(hit.description ?? '');
    setMasterHits([]);
  };

  const generateVariants = () => {
    const drafts = buildVariants(axes);
    if (drafts.length === 0) {
      toast.error('Escribe ejes como “talla: S, M, L” o “color: negro, rojo”.');
      return;
    }
    setVariantDrafts(drafts);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const priceValue = Number(price.replace(',', '.'));
    if (!name.trim() || !Number.isFinite(priceValue) || priceValue < 0) {
      toast.error('Completa nombre y precio.');
      return;
    }

    const variants = variantDrafts.map((draft) => ({
      optionValues: draft.optionValues,
      sku: draft.sku.trim() || null,
      priceCents: draft.price.trim() ? Math.round(Number(draft.price.replace(',', '.')) * 100) : null,
      initialStock: Math.max(0, Math.floor(Number(draft.stock) || 0)),
    }));

    setBusy(true);
    try {
      const response = await fetch(`/api/merchant/stores/${storeId}/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          masterProductId: master?.id ?? null,
          name: name.trim(),
          category: category.trim() || null,
          brand: brand.trim() || null,
          description: description.trim() || null,
          priceCents: Math.round(priceValue * 100),
          unit: unit || 'unidad',
          initialStock: variants.length === 0 ? Math.max(0, Math.floor(Number(stock) || 0)) : 0,
          variants,
          visible: true,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'No se pudo crear el producto.');
      toast.success('Producto publicado');
      resetForm();
      setMode(null);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo crear el producto.');
    } finally {
      setBusy(false);
    }
  };

  const patchProduct = async (
    productId: string,
    body: Record<string, unknown>,
    success: string,
  ) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/merchant/stores/${storeId}/products/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'No se pudo guardar.');
      toast.success(success);
      setEditingId(null);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  };

  const archive = (product: MerchantProduct) => {
    if (!window.confirm(`Archivar “${product.name}”? No se borra: los pedidos históricos conservan su snapshot.`)) {
      return;
    }
    void patchProduct(product.id, { archived: true, visible: false }, 'Producto archivado');
  };

  const patchVariant = async (
    product: MerchantProduct,
    variantId: string,
    body: Record<string, unknown>,
  ) => {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/merchant/stores/${storeId}/products/${product.id}/variants/${variantId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'No se pudo guardar la variante.');
      toast.success('Variante actualizada');
      setVariantEdit(null);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo guardar la variante.');
    } finally {
      setBusy(false);
    }
  };

  const archiveVariant = (product: MerchantProduct, variant: CatalogVariant) => {
    if (!window.confirm('Archivar esta variante? El historial de pedidos no se modifica.')) return;
    void patchVariant(product, variant.id, { archived: true, active: false });
  };

  const uploadLogo = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('scope', 'store_logo');
      const response = await fetch(`/api/merchant/stores/${storeId}/media`, {
        method: 'POST',
        body: form,
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'No se pudo subir el logo.');
      toast.success('Logo actualizado');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo subir el logo.');
    } finally {
      setBusy(false);
    }
  };

  const uploadImage = async (product: MerchantProduct, file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('scope', 'product_image');
      form.set('productId', product.id);
      const response = await fetch(`/api/merchant/stores/${storeId}/media`, {
        method: 'POST',
        body: form,
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'No se pudo subir la imagen.');
      toast.success('Imagen actualizada');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo subir la imagen.');
    } finally {
      setBusy(false);
    }
  };

  const adjustStock = async (product: MerchantProduct) => {
    const delta = Number(stockDelta);
    if (!Number.isInteger(delta) || delta === 0) {
      toast.error('El ajuste debe ser un entero distinto de 0.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/merchant/stores/${storeId}/inventory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: product.id,
          variantKey: stockVariantKey,
          delta,
          reason: stockReason,
        }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'No se pudo ajustar el stock.');
      toast.success('Stock actualizado');
      setStockProductId(null);
      setStockDelta('');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo ajustar el stock.');
    } finally {
      setBusy(false);
    }
  };

  const addVariant = async (product: MerchantProduct) => {
    const axesParsed = parseVariantAxesInput(variantAxes);
    if (axesParsed.length === 0) {
      toast.error('Escribe los ejes, ej. “talla: M, L”.');
      return;
    }
    const optionValues: Record<string, string> = {};
    for (const axis of axesParsed) {
      optionValues[axis.name] = axis.values[0];
    }
    setBusy(true);
    try {
      const response = await fetch(
        `/api/merchant/stores/${storeId}/products/${product.id}/variants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            optionValues,
            sku: variantSku || null,
            priceCents: variantPrice ? Math.round(Number(variantPrice.replace(',', '.')) * 100) : null,
            initialStock: Math.max(0, Math.floor(Number(variantStock) || 0)),
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'No se pudo agregar la variante.');
      toast.success('Variante agregada');
      setVariantProductId(null);
      setVariantSku('');
      setVariantPrice('');
      setVariantStock('0');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo agregar la variante.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar en mi catálogo…"
          className="h-10 min-w-40 flex-1 rounded-xl border border-border-strong bg-background px-3 text-sm"
        />
        {categories.length > 0 && (
          <select
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
            aria-label="Filtrar por categoría"
            className="h-10 rounded-xl border border-border-strong bg-background px-2 text-sm"
          >
            <option value="">Todas las categorías</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={openMaster}
          className="h-10 rounded-xl bg-brand px-4 text-sm font-semibold text-background"
        >
          + Del catálogo maestro
        </button>
        <button
          type="button"
          onClick={openOwn}
          className="h-10 rounded-xl border border-border-strong px-4 text-sm font-medium hover:bg-surface-raised"
        >
          + Producto propio
        </button>
        <button
          type="button"
          onClick={() => logoInput.current?.click()}
          className="h-10 rounded-xl border border-border-strong px-3 text-sm text-secondary hover:bg-surface-raised"
        >
          Logo
        </button>
        <input
          ref={logoInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadLogo(file);
            event.target.value = '';
          }}
        />
      </div>

      {mode && (
        <form onSubmit={submit} className="mt-4 rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              {master ? `Agregar “${master.name}”` : 'Crear producto propio'}
            </h3>
            <button type="button" onClick={() => { setMode(null); resetForm(); }} className="text-xs text-tertiary hover:text-primary">
              Cerrar
            </button>
          </div>

          {mode === 'master' && !master && (
            <div className="mt-3 rounded-xl border border-border p-3">
              <div className="flex gap-2">
                <input
                  value={masterQuery}
                  onChange={(event) => setMasterQuery(event.target.value)}
                  placeholder="Buscar arroz, polo, tela, martillo…"
                  className="h-10 flex-1 rounded-xl border border-border-strong bg-background px-3 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void searchMaster()}
                  disabled={busy}
                  className="h-10 rounded-xl border border-border-strong px-3 text-sm"
                >
                  Buscar
                </button>
              </div>
              {masterHits.length > 0 && (
                <ul className="mt-2 divide-y divide-border">
                  {masterHits.map((hit) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        onClick={() => chooseMaster(hit)}
                        className="flex w-full items-center justify-between gap-3 py-2 text-left text-sm hover:bg-surface-raised/60"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{hit.name}</span>
                          <span className="block truncate text-xs text-tertiary">
                            {[hit.brand, hit.category].filter(Boolean).join(' · ') || 'Sin marca'}
                          </span>
                        </span>
                        <span className="text-xs text-brand">Elegir</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {(mode === 'own' || master) && (
            <>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-xs text-tertiary sm:col-span-2">
                  Nombre
                  <input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm" />
                </label>
                <label className="text-xs text-tertiary">
                  Precio (S/)
                  <input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" required className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm" />
                </label>
                <label className="text-xs text-tertiary">
                  Categoría
                  <input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={80} className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm" />
                </label>
                <label className="text-xs text-tertiary">
                  Marca
                  <input value={brand} onChange={(event) => setBrand(event.target.value)} maxLength={80} className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm" />
                </label>
                <label className="text-xs text-tertiary">
                  Unidad
                  <select value={unit} onChange={(event) => setUnit(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm">
                    <option value="unidad">unidad</option>
                    <option value="kg">kg</option>
                    <option value="metro">metro</option>
                    <option value="litro">litro</option>
                    <option value="paquete">paquete</option>
                  </select>
                </label>
                <label className="text-xs text-tertiary sm:col-span-2">
                  Descripción
                  <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={4000} className="mt-1 w-full rounded-xl border border-border-strong bg-background px-3 py-2 text-sm" />
                </label>
              </div>

              <div className="mt-3 rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex-1 text-xs text-tertiary">
                    Variantes (opcional)
                    <input
                      value={axes}
                      onChange={(event) => setAxes(event.target.value)}
                      placeholder="talla: S, M, L; color: negro, rojo"
                      className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm"
                    />
                  </label>
                  <button type="button" onClick={generateVariants} className="h-10 rounded-xl border border-border-strong px-3 text-sm">
                    Generar combinaciones
                  </button>
                </div>
                {variantDrafts.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {variantDrafts.map((draft, index) => (
                      <div key={Object.values(draft.optionValues).join('|')} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr]">
                        <div className="self-center text-xs text-secondary">{Object.values(draft.optionValues).join(' · ')}</div>
                        <input
                          value={draft.sku}
                          onChange={(event) =>
                            setVariantDrafts((current) =>
                              current.map((item, i) => (i === index ? { ...item, sku: event.target.value } : item)),
                            )
                          }
                          placeholder="SKU (auto)"
                          className="h-9 rounded-lg border border-border-strong bg-background px-2 text-xs"
                        />
                        <input
                          value={draft.price}
                          onChange={(event) =>
                            setVariantDrafts((current) =>
                              current.map((item, i) => (i === index ? { ...item, price: event.target.value } : item)),
                            )
                          }
                          placeholder="Precio (opcional)"
                          inputMode="decimal"
                          className="h-9 rounded-lg border border-border-strong bg-background px-2 text-xs"
                        />
                        <input
                          value={draft.stock}
                          onChange={(event) =>
                            setVariantDrafts((current) =>
                              current.map((item, i) => (i === index ? { ...item, stock: event.target.value } : item)),
                            )
                          }
                          placeholder="Stock"
                          inputMode="numeric"
                          className="h-9 rounded-lg border border-border-strong bg-background px-2 text-xs"
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <label className="mt-3 block text-xs text-tertiary">
                    Stock inicial (producto sin variantes)
                    <input value={stock} onChange={(event) => setStock(event.target.value)} inputMode="numeric" className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm" />
                  </label>
                )}
              </div>

              <button type="submit" disabled={busy} className="mt-3 h-10 rounded-xl bg-brand px-4 text-sm font-semibold text-background disabled:opacity-50">
                {busy ? 'Guardando…' : 'Guardar y publicar'}
              </button>
            </>
          )}
        </form>
      )}

      {filtered.length === 0 ? (
        <p className="py-4 text-sm text-tertiary">Sin productos que coincidan.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {filtered.map((product) => {
            const isEditing = editingId === product.id;
            return (
              <li key={product.id} className="py-3">
                <div className="flex items-start gap-3">
                  {product.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- imagen del comercio
                    <img src={product.imageUrl} alt="" className="h-12 w-12 rounded-lg border border-border object-cover" />
                  ) : (
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-surface-raised text-sm font-semibold text-tertiary">
                      {product.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{product.name}</span>
                      {!product.visible && <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted">oculto</span>}
                      {product.variants.length > 0 && (
                        <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted">
                          {product.variants.length} variantes
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-tertiary">
                      /{product.slug} · {money(product.priceCents, product.currency)} · {product.available} disp.
                    </div>
                    {product.variants.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-tertiary">
                        {product.variants.map((variant) => (
                          <span key={variant.id} className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono">
                            {Object.values(variant.optionValues).join('/')} · {variant.sku} · {variant.available}
                            <button
                              type="button"
                              onClick={() =>
                                setVariantEdit({
                                  variantId: variant.id,
                                  sku: variant.sku,
                                  price: variant.priceCents === null ? '' : (variant.priceCents / 100).toFixed(2),
                                })
                              }
                              className="text-[10px] text-secondary underline underline-offset-2"
                            >
                              editar
                            </button>
                            <button
                              type="button"
                              onClick={() => archiveVariant(product, variant)}
                              className="text-[10px] text-destructive/80"
                            >
                              archivar
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(isEditing ? null : product.id);
                        setEditName(product.name);
                        setEditPrice((product.priceCents / 100).toFixed(2));
                      }}
                      className="text-xs text-secondary hover:text-primary"
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      onClick={() => void patchProduct(product.id, { visible: !product.visible }, product.visible ? 'Producto oculto' : 'Producto publicado')}
                      className="text-xs text-secondary hover:text-primary"
                    >
                      {product.visible ? 'Despublicar' : 'Publicar'}
                    </button>
                    <button type="button" onClick={() => archive(product)} className="text-xs text-destructive/80 hover:text-destructive">
                      Archivar
                    </button>
                  </div>
                </div>

                {isEditing && (
                  <div className="mt-3 rounded-xl border border-border bg-surface p-3">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="text-xs text-tertiary">
                        Nombre
                        <input value={editName} onChange={(event) => setEditName(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-border-strong bg-background px-2 text-sm" />
                      </label>
                      <label className="text-xs text-tertiary">
                        Precio (S/)
                        <input value={editPrice} onChange={(event) => setEditPrice(event.target.value)} inputMode="decimal" className="mt-1 h-9 w-full rounded-lg border border-border-strong bg-background px-2 text-sm" />
                      </label>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          void patchProduct(
                            product.id,
                            {
                              name: editName.trim() || undefined,
                              priceCents: Math.round(Number(editPrice.replace(',', '.')) * 100),
                            },
                            'Producto actualizado',
                          )
                        }
                        className="h-9 rounded-lg bg-brand px-3 text-xs font-semibold text-background"
                      >
                        Guardar cambios
                      </button>
                      <button
                        type="button"
                        onClick={() => setStockProductId(stockProductId === product.id ? null : product.id)}
                        className="h-9 rounded-lg border border-border-strong px-3 text-xs"
                      >
                        Ajustar stock
                      </button>
                      <button
                        type="button"
                        onClick={() => setVariantProductId(variantProductId === product.id ? null : product.id)}
                        className="h-9 rounded-lg border border-border-strong px-3 text-xs"
                      >
                        Agregar variante
                      </button>
                      <button
                        type="button"
                        onClick={() => fileInputs.current[product.id]?.click()}
                        className="h-9 rounded-lg border border-border-strong px-3 text-xs"
                      >
                        Subir imagen
                      </button>
                      <input
                        ref={(element) => { fileInputs.current[product.id] = element; }}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadImage(product, file);
                          event.target.value = '';
                        }}
                      />
                    </div>

                    {stockProductId === product.id && (
                      <div className="mt-2 flex flex-wrap items-end gap-2">
                        <label className="text-xs text-tertiary">
                          Variante
                          <select value={stockVariantKey} onChange={(event) => setStockVariantKey(event.target.value)} className="mt-1 block h-9 rounded-lg border border-border-strong bg-background px-2 text-xs">
                            {product.variants.length === 0 && <option value="">Sin variantes</option>}
                            {product.variants.map((variant) => (
                              <option key={variant.id} value={variant.variantKey}>
                                {Object.values(variant.optionValues).join(' / ')} ({variant.sku})
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="text-xs text-tertiary">
                          Delta (+/−)
                          <input value={stockDelta} onChange={(event) => setStockDelta(event.target.value)} inputMode="numeric" className="mt-1 block h-9 w-20 rounded-lg border border-border-strong bg-background px-2 text-xs" />
                        </label>
                        <label className="text-xs text-tertiary">
                          Motivo
                          <input value={stockReason} onChange={(event) => setStockReason(event.target.value)} className="mt-1 block h-9 w-40 rounded-lg border border-border-strong bg-background px-2 text-xs" />
                        </label>
                        <button type="button" onClick={() => void adjustStock(product)} className="h-9 rounded-lg bg-brand px-3 text-xs font-semibold text-background">
                          Aplicar
                        </button>
                      </div>
                    )}

                    {variantEdit &&
                      product.variants.some((variant) => variant.id === variantEdit.variantId) && (
                        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-border p-2">
                          <label className="text-xs text-tertiary">
                            SKU
                            <input
                              value={variantEdit.sku}
                              onChange={(event) =>
                                setVariantEdit({ ...variantEdit, sku: event.target.value })
                              }
                              className="mt-1 block h-9 w-40 rounded-lg border border-border-strong bg-background px-2 text-xs"
                            />
                          </label>
                          <label className="text-xs text-tertiary">
                            Precio (S/, vacío = precio base)
                            <input
                              value={variantEdit.price}
                              onChange={(event) =>
                                setVariantEdit({ ...variantEdit, price: event.target.value })
                              }
                              inputMode="decimal"
                              className="mt-1 block h-9 w-28 rounded-lg border border-border-strong bg-background px-2 text-xs"
                            />
                          </label>
                          <button
                            type="button"
                            onClick={() =>
                              void patchVariant(product, variantEdit.variantId, {
                                sku: variantEdit.sku.trim(),
                                priceCents: variantEdit.price.trim()
                                  ? Math.round(Number(variantEdit.price.replace(',', '.')) * 100)
                                  : null,
                              })
                            }
                            className="h-9 rounded-lg bg-brand px-3 text-xs font-semibold text-background"
                          >
                            Guardar variante
                          </button>
                          <button
                            type="button"
                            onClick={() => setVariantEdit(null)}
                            className="h-9 rounded-lg border border-border-strong px-3 text-xs"
                          >
                            Cancelar
                          </button>
                        </div>
                      )}

                    {variantProductId === product.id && (
                      <div className="mt-2 flex flex-wrap items-end gap-2">
                        <label className="text-xs text-tertiary">
                          Ejes
                          <input value={variantAxes} onChange={(event) => setVariantAxes(event.target.value)} placeholder="talla: M; color: negro" className="mt-1 block h-9 w-56 rounded-lg border border-border-strong bg-background px-2 text-xs" />
                        </label>
                        <label className="text-xs text-tertiary">
                          SKU
                          <input value={variantSku} onChange={(event) => setVariantSku(event.target.value)} className="mt-1 block h-9 w-28 rounded-lg border border-border-strong bg-background px-2 text-xs" />
                        </label>
                        <label className="text-xs text-tertiary">
                          Precio
                          <input value={variantPrice} onChange={(event) => setVariantPrice(event.target.value)} inputMode="decimal" className="mt-1 block h-9 w-20 rounded-lg border border-border-strong bg-background px-2 text-xs" />
                        </label>
                        <label className="text-xs text-tertiary">
                          Stock
                          <input value={variantStock} onChange={(event) => setVariantStock(event.target.value)} inputMode="numeric" className="mt-1 block h-9 w-20 rounded-lg border border-border-strong bg-background px-2 text-xs" />
                        </label>
                        <button type="button" onClick={() => void addVariant(product)} className="h-9 rounded-lg bg-brand px-3 text-xs font-semibold text-background">
                          Agregar
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
