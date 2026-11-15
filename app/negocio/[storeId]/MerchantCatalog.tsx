'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Package, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';
import { EmptyState } from '@/components/ui/EmptyState';
import { centsToInput, formatMoney, parseMoneyInputToCents, unitsToCents } from '@/lib/format';
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

function buildVariants(axes: string): VariantDraft[] {
  try {
    const schema = parseVariantAxesInput(axes);
    return cartesianVariants(schema).map((optionValues) => ({
      optionValues,
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
  const { locale, t } = useI18n();
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
  const [stockMode, setStockMode] = useState<'in' | 'out'>('in');
  const [stockQty, setStockQty] = useState('');
  const [variantProductId, setVariantProductId] = useState<string | null>(null);
  const [variantValues, setVariantValues] = useState<Record<string, string>>({});
  const [variantPrice, setVariantPrice] = useState('');
  const [variantStock, setVariantStock] = useState('0');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [variantEdit, setVariantEdit] = useState<{
    variantId: string;
    sku: string;
    price: string;
  } | null>(null);

  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const createGalleryInput = useRef<HTMLInputElement | null>(null);
  const createCameraInput = useRef<HTMLInputElement | null>(null);

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

  const clearFilters = () => {
    setQuery('');
    setCategoryFilter('');
  };

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
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(null);
    setImagePreview(null);
    setMaster(null);
    setMasterQuery('');
    setMasterHits([]);
  };

  const chooseImage = (file: File | undefined) => {
    if (!file) return;
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
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
      if (!response.ok) throw new Error(payload?.error ?? t('merchant.searchFailed'));
      setMasterHits(payload?.products ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('merchant.searchFailed'));
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
      toast.error(t('merchant.axesExampleError'));
      return;
    }
    setVariantDrafts(drafts);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const priceValue = Number(price.replace(',', '.'));
    if (!name.trim() || !Number.isFinite(priceValue) || priceValue < 0) {
      toast.error(t('merchant.requiredNamePrice'));
      return;
    }

    const variants = variantDrafts.map((draft) => ({
      optionValues: draft.optionValues,
      priceCents: parseMoneyInputToCents(draft.price),
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
          priceCents: unitsToCents(priceValue),
          unit: unit || 'unidad',
          initialStock: variants.length === 0 ? Math.max(0, Math.floor(Number(stock) || 0)) : 0,
          variants,
          visible: true,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        product?: { id: string } | null;
      } | null;
      if (!response.ok) throw new Error(payload?.error ?? t('merchant.createFailed'));

      // La foto se sube después del alta porque el servidor la asocia al id
      // recién generado. Si falla, el producto ya quedó creado: se avisa aparte.
      if (imageFile && payload?.product?.id) {
        try {
          await uploadProductImage(payload.product.id, imageFile);
        } catch {
          toast.error(t('merchant.uploadImageFailed'));
        }
      }

      toast.success(t('merchant.productPublished'));
      resetForm();
      setMode(null);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('merchant.createFailed'));
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
      if (!response.ok) throw new Error(payload?.error ?? t('merchant.saveFailed'));
      toast.success(success);
      setEditingId(null);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('merchant.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  /** Sube la imagen de un producto ya creado (la usa el alta y la edición). */
  const uploadProductImage = async (productId: string, file: File) => {
    const form = new FormData();
    form.set('file', file);
    form.set('scope', 'product_image');
    form.set('productId', productId);
    const response = await fetch(`/api/merchant/stores/${storeId}/media`, {
      method: 'POST',
      body: form,
    });
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) throw new Error(payload?.error ?? t('merchant.uploadImageFailed'));
  };

  const importProductImage = async (product: MerchantProduct, file: File) => {
    setBusy(true);
    try {
      await uploadProductImage(product.id, file);
      toast.success(t('merchant.imageUpdated'));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('merchant.uploadImageFailed'));
    } finally {
      setBusy(false);
    }
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
      if (!response.ok) throw new Error(payload?.error ?? t('merchant.saveVariantFailed'));
      toast.success(t('merchant.variantUpdated'));
      setVariantEdit(null);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('merchant.saveVariantFailed'));
    } finally {
      setBusy(false);
    }
  };

  const archiveVariant = (product: MerchantProduct, variant: CatalogVariant) => {
    if (!window.confirm(t('merchant.archiveVariantConfirm'))) return;
    void patchVariant(product, variant.id, { archived: true, active: false });
  };



  const adjustStock = async (product: MerchantProduct) => {
    const quantity = Math.floor(Number(stockQty));
    if (!Number.isInteger(quantity) || quantity <= 0) {
      toast.error(t('merchant.stockQuantityInvalid'));
      return;
    }
    // Ingreso suma; merma resta. El comerciante escribe siempre una cantidad
    // positiva y elige qué pasó, sin pensar en signos ni deltas.
    const delta = stockMode === 'in' ? quantity : -quantity;
    setBusy(true);
    try {
      const response = await fetch(`/api/merchant/stores/${storeId}/inventory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: product.id,
          variantKey: stockVariantKey,
          delta,
          reason: stockMode === 'in' ? t('merchant.stockInReason') : t('merchant.stockOutReason'),
        }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? t('merchant.adjustStockFailed'));
      toast.success(t('merchant.stockUpdated'));
      setStockProductId(null);
      setStockQty('');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('merchant.adjustStockFailed'));
    } finally {
      setBusy(false);
    }
  };

  /** Ejes que ya usa la tienda; si el producto no tiene, se pide un solo valor. */
  const variantAxesFor = (product: MerchantProduct): string[] => {
    if (product.optionSchema.length > 0) return product.optionSchema.map((axis) => axis.name);
    const first = product.variants[0];
    return first ? Object.keys(first.optionValues) : [];
  };

  const addVariant = async (product: MerchantProduct) => {
    const axes = variantAxesFor(product);
    const optionValues: Record<string, string> = {};
    if (axes.length === 0) {
      const value = (variantValues.__value ?? '').trim();
      if (!value) {
        toast.error(t('merchant.variantValueRequired'));
        return;
      }
      optionValues['Opción'] = value;
    } else {
      for (const axis of axes) {
        const value = (variantValues[axis] ?? '').trim();
        if (!value) {
          toast.error(t('merchant.variantValueRequired'));
          return;
        }
        optionValues[axis] = value;
      }
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
            priceCents: parseMoneyInputToCents(variantPrice),
            initialStock: Math.max(0, Math.floor(Number(variantStock) || 0)),
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? t('merchant.addVariantFailed'));
      toast.success(t('merchant.variantAdded'));
      setVariantProductId(null);
      setVariantValues({});
      setVariantPrice('');
      setVariantStock('0');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('merchant.addVariantFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <div className="surface-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('merchant.catalogSearch')}
            className="h-11 min-w-40 flex-1 rounded-xl border border-border-strong bg-background px-3 text-sm"
          />
          {categories.length > 0 && (
            <select
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              aria-label={t('merchant.filterCategory')}
              className="h-11 rounded-xl border border-border-strong bg-background px-2 text-sm"
            >
              <option value="">{t('merchant.allCategories')}</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          )}
          <button type="button" onClick={openMaster} className="btn-primary shrink-0 text-sm">
            {t('merchant.addFromMaster')}
          </button>
          <button type="button" onClick={openOwn} className="btn-secondary shrink-0 text-sm">
            {t('merchant.addOwn')}
          </button>
        </div>
      </div>

      {mode && (
        <form onSubmit={submit} className="surface-card relative mt-3 overflow-hidden p-4 sm:p-5">
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent"
          />
          <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[2px] text-muted">
                {t('merchant.productFormKicker')}
              </p>
              <h3 className="mt-1 text-lg font-semibold tracking-tight">
                {master
                  ? t('merchant.addMasterTitle', { name: master.name })
                  : t('merchant.createOwnTitle')}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => {
                setMode(null);
                resetForm();
              }}
              className="inline-flex h-8 shrink-0 items-center rounded-full border border-border-strong px-3 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-primary"
            >
              {t('merchant.close')}
            </button>
          </div>

          {mode === 'master' && !master && (
            <div className="mt-4 rounded-2xl border border-border bg-surface-raised/40 p-3">
              <div className="flex gap-2">
                <input
                  value={masterQuery}
                  onChange={(event) => setMasterQuery(event.target.value)}
                  placeholder={t('merchant.masterSearchPlaceholder')}
                  className="h-10 min-w-0 flex-1 rounded-xl border border-border-strong bg-background px-3 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void searchMaster()}
                  disabled={busy}
                  className="inline-flex h-10 shrink-0 items-center rounded-full border border-border-strong px-3 text-sm font-medium transition-colors hover:bg-surface-raised disabled:opacity-50"
                >
                  {t('merchant.search')}
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
                            {[hit.brand, hit.category].filter(Boolean).join(' · ') || t('merchant.noBrand')}
                          </span>
                        </span>
                        <span className="text-xs text-brand">{t('merchant.choose')}</span>
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
                  {t('merchant.name')}
                  <input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required className="field-input mt-1 h-10 text-sm" />
                </label>
                <label className="text-xs text-tertiary">
                  {t('merchant.pricePEN')}
                  <input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" required className="field-input mt-1 h-10 text-sm" />
                </label>
                <label className="text-xs text-tertiary">
                  {t('merchant.category')}
                  <input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={80} className="field-input mt-1 h-10 text-sm" />
                </label>
                <label className="text-xs text-tertiary">
                  {t('merchant.brand')}
                  <input value={brand} onChange={(event) => setBrand(event.target.value)} maxLength={80} className="field-input mt-1 h-10 text-sm" />
                </label>
                <label className="text-xs text-tertiary">
                  {t('merchant.unit')}
                  <select value={unit} onChange={(event) => setUnit(event.target.value)} className="field-input mt-1 h-10 text-sm">
                    <option value="unidad">{t('merchant.unitUnit')}</option>
                    <option value="kg">{t('merchant.unitKg')}</option>
                    <option value="metro">{t('merchant.unitMeter')}</option>
                    <option value="litro">{t('merchant.unitLiter')}</option>
                    <option value="paquete">{t('merchant.unitPack')}</option>
                  </select>
                </label>
                <label className="text-xs text-tertiary sm:col-span-2">
                  {t('merchant.description')}
                  <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={4000} className="field-input mt-1 text-sm" />
                </label>
              </div>

              <div className="mt-4 rounded-2xl border border-border bg-surface-raised/40 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-[2px] text-muted">
                  {t('merchant.productPhoto')}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => createGalleryInput.current?.click()}
                    className="inline-flex h-10 items-center rounded-full border border-border-strong px-3 text-sm font-medium transition-colors hover:bg-surface-raised"
                  >
                    {t('merchant.chooseImage')}
                  </button>
                  <button
                    type="button"
                    onClick={() => createCameraInput.current?.click()}
                    className="inline-flex h-10 items-center rounded-full border border-border-strong px-3 text-sm font-medium transition-colors hover:bg-surface-raised"
                  >
                    {t('merchant.takePhoto')}
                  </button>
                  {imageFile && <span className="text-xs text-secondary">{imageFile.name}</span>}
                </div>
                {imagePreview && (
                  // eslint-disable-next-line @next/next/no-img-element -- vista previa local
                  <img src={imagePreview} alt="" className="mt-2 h-24 w-24 rounded-lg border border-border object-cover" />
                )}
                <p className="mt-1 text-[11px] text-muted">{t('merchant.productPhotoHint')}</p>
                <input
                  ref={createGalleryInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    chooseImage(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
                <input
                  ref={createCameraInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="environment"
                  className="hidden"
                  onChange={(event) => {
                    chooseImage(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </div>

              <div className="mt-4 rounded-2xl border border-border bg-surface-raised/40 p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex-1 text-xs text-tertiary">
                    {t('merchant.variantsOptional')}
                    <input
                      value={axes}
                      onChange={(event) => setAxes(event.target.value)}
                      placeholder={t('merchant.variantsPlaceholder')}
                      className="field-input mt-1 h-10 text-sm"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={generateVariants}
                    className="inline-flex h-10 items-center rounded-full border border-border-strong px-3 text-sm font-medium transition-colors hover:bg-surface-raised"
                  >
                    {t('merchant.generateCombinations')}
                  </button>
                </div>
                {variantDrafts.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    <div className="grid gap-2 text-[11px] uppercase tracking-wide text-muted sm:grid-cols-[1fr_1fr_1fr]">
                      <span>{t('merchant.variant')}</span>
                      <span>{t('merchant.priceOptional')}</span>
                      <span>{t('merchant.stock')}</span>
                    </div>
                    {variantDrafts.map((draft, index) => (
                      <div key={Object.values(draft.optionValues).join('|')} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr]">
                        <div className="self-center text-xs text-secondary">{Object.values(draft.optionValues).join(' · ')}</div>
                        <input
                          value={draft.price}
                          onChange={(event) =>
                            setVariantDrafts((current) =>
                              current.map((item, i) => (i === index ? { ...item, price: event.target.value } : item)),
                            )
                          }
                          placeholder={t('merchant.priceOptional')}
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
                          placeholder={t('merchant.stock')}
                          inputMode="numeric"
                          className="h-9 rounded-lg border border-border-strong bg-background px-2 text-xs"
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <label className="mt-3 block text-xs text-tertiary">
                    {t('merchant.initialStock')}
                    <input value={stock} onChange={(event) => setStock(event.target.value)} inputMode="numeric" className="field-input mt-1 h-10 text-sm" />
                  </label>
                )}
              </div>

              <button type="submit" disabled={busy} className="btn-primary mt-4 w-full sm:w-auto">
                {busy ? t('merchant.saving') : t('merchant.savePublish')}
              </button>
            </>
          )}
        </form>
      )}

      {products.length === 0 ? (
        <EmptyState
          icon={Package}
          title={t('merchant.catalogEmptyTitle')}
          description={t('merchant.catalogEmptyBody')}
          action={
            <>
              <button type="button" onClick={openMaster} className="btn-primary text-sm">
                {t('merchant.addFromMaster')}
              </button>
              <button type="button" onClick={openOwn} className="btn-secondary text-sm">
                {t('merchant.addOwn')}
              </button>
            </>
          }
          className="mt-3"
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          compact
          icon={Search}
          title={t('merchant.noMatches')}
          description={t('merchant.noMatchesBody')}
          action={
            <button type="button" onClick={clearFilters} className="btn-secondary text-sm">
              {t('merchant.clearFilters')}
            </button>
          }
          className="mt-3"
        />
      ) : (
        <ul className="mt-3 space-y-2">
          {filtered.map((product) => {
            const isEditing = editingId === product.id;
            return (
              <li
                key={product.id}
                className="surface-card p-3 transition-colors hover:border-border-strong sm:p-4"
              >
                <div className="flex items-start gap-3 sm:gap-4">
                  {product.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- imagen del comercio
                    <img
                      src={product.imageUrl}
                      alt=""
                      className="h-14 w-14 shrink-0 rounded-xl border border-border object-cover"
                    />
                  ) : (
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-raised text-base font-semibold text-tertiary">
                      {product.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-body font-semibold text-primary">
                        {product.name}
                      </span>
                      {!product.visible && (
                        <span className="rounded-full border border-border bg-surface-raised px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
                          {t('merchant.hiddenBadge')}
                        </span>
                      )}
                      {product.variants.length > 0 && (
                        <span className="rounded-full border border-border bg-surface-raised px-2 py-0.5 text-[10px] font-medium text-tertiary">
                          {t('merchant.variantsCount', { count: product.variants.length })}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-tertiary">
                      <span className="font-mono text-sm font-semibold tabular-nums text-primary">
                        {formatMoney(product.priceCents, product.currency, locale)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span
                        className={
                          product.available <= 0
                            ? 'font-medium text-destructive'
                            : 'text-secondary'
                        }
                      >
                        {t('merchant.availableShort', { count: product.available })}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">/{product.slug}</span>
                    </div>
                    {product.variants.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-tertiary">
                        {product.variants.map((variant) => (
                          <span
                            key={variant.id}
                            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-raised/60 px-2 py-0.5 font-mono"
                          >
                            {Object.values(variant.optionValues).join('/')} · {variant.sku} · {variant.available}
                            <button
                              type="button"
                              onClick={() =>
                                setVariantEdit({
                                  variantId: variant.id,
                                  sku: variant.sku,
                                  price: centsToInput(variant.priceCents),
                                })
                              }
                              className="text-[10px] text-secondary underline underline-offset-2"
                            >
                              {t('merchant.edit')}
                            </button>
                            <button
                              type="button"
                              onClick={() => archiveVariant(product, variant)}
                              className="text-[10px] text-destructive/80"
                            >
                              {t('merchant.archive')}
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                </div>

                {/* Acciones grandes y con borde: se usan desde el celular. */}
                <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(isEditing ? null : product.id);
                      setEditName(product.name);
                      setEditPrice(centsToInput(product.priceCents));
                      setStockProductId(null);
                      setVariantProductId(null);
                    }}
                    className="inline-flex h-9 items-center rounded-full border border-border-strong px-3 text-xs font-medium transition-colors hover:bg-surface-raised"
                  >
                    {isEditing ? t('merchant.close') : t('merchant.edit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void patchProduct(product.id, { visible: !product.visible }, product.visible ? t('merchant.productHidden') : t('merchant.productPublished'))}
                    className="inline-flex h-9 items-center rounded-full border border-border-strong px-3 text-xs font-medium transition-colors hover:bg-surface-raised"
                  >
                    {product.visible ? t('merchant.unpublish') : t('merchant.publish')}
                  </button>
                </div>

                {isEditing && (
                  <div className="mt-3 rounded-2xl border border-border bg-surface-raised/40 p-3">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="text-xs text-tertiary">
                        {t('merchant.name')}
                        <input value={editName} onChange={(event) => setEditName(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-border-strong bg-background px-2 text-sm" />
                      </label>
                      <label className="text-xs text-tertiary">
                        {t('merchant.pricePEN')}
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
                              priceCents: parseMoneyInputToCents(editPrice) ?? 0,
                            },
                            t('merchant.productUpdated'),
                          )
                        }
                        className="inline-flex h-9 items-center rounded-full bg-brand px-3 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {t('merchant.saveChanges')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setStockProductId(stockProductId === product.id ? null : product.id);
                          setStockQty('');
                          setStockMode('in');
                        }}
                        className="inline-flex h-9 items-center rounded-full border border-border-strong px-3 text-xs font-medium transition-colors hover:bg-surface-raised"
                      >
                        {t('merchant.adjustStock')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setVariantProductId(variantProductId === product.id ? null : product.id);
                          setVariantValues({});
                          setVariantPrice('');
                          setVariantStock('0');
                        }}
                        className="inline-flex h-9 items-center rounded-full border border-border-strong px-3 text-xs font-medium transition-colors hover:bg-surface-raised"
                      >
                        {t('merchant.addVariant')}
                      </button>
                      <button
                        type="button"
                        onClick={() => fileInputs.current[product.id]?.click()}
                        className="inline-flex h-9 items-center rounded-full border border-border-strong px-3 text-xs font-medium transition-colors hover:bg-surface-raised"
                      >
                        {t('merchant.uploadImage')}
                      </button>
                      <input
                        ref={(element) => { fileInputs.current[product.id] = element; }}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void importProductImage(product, file);
                          event.target.value = '';
                        }}
                      />
                    </div>

                    {stockProductId === product.id && (
                      <div className="mt-3 rounded-xl border border-border bg-background/60 p-3">
                        <div className="flex flex-wrap items-end gap-2">
                          <label className="text-xs text-tertiary">
                            {t('merchant.variant')}
                            <select value={stockVariantKey} onChange={(event) => setStockVariantKey(event.target.value)} className="mt-1 block h-9 rounded-lg border border-border-strong bg-background px-2 text-xs">
                              {product.variants.length === 0 && <option value="">{t('merchant.noVariants')}</option>}
                              {product.variants.map((variant) => (
                                <option key={variant.id} value={variant.variantKey}>
                                  {Object.values(variant.optionValues).join(' / ')} ({variant.sku})
                                </option>
                              ))}
                            </select>
                          </label>
                          <div>
                            <span className="text-xs text-tertiary">{t('merchant.stockMovement')}</span>
                            <div className="mt-1 flex overflow-hidden rounded-lg border border-border-strong">
                              <button
                                type="button"
                                aria-pressed={stockMode === 'in'}
                                onClick={() => setStockMode('in')}
                                className={`h-9 px-3 text-xs font-medium ${stockMode === 'in' ? 'bg-brand text-background' : 'bg-background text-secondary'}`}
                              >
                                {t('merchant.stockIn')}
                              </button>
                              <button
                                type="button"
                                aria-pressed={stockMode === 'out'}
                                onClick={() => setStockMode('out')}
                                className={`h-9 px-3 text-xs font-medium ${stockMode === 'out' ? 'bg-brand text-background' : 'bg-background text-secondary'}`}
                              >
                                {t('merchant.stockOut')}
                              </button>
                            </div>
                          </div>
                          <label className="text-xs text-tertiary">
                            {t('merchant.stockQty')}
                            <input value={stockQty} onChange={(event) => setStockQty(event.target.value)} inputMode="numeric" className="mt-1 block h-9 w-24 rounded-lg border border-border-strong bg-background px-2 text-xs" />
                          </label>
                          <button type="button" onClick={() => void adjustStock(product)} className="h-9 rounded-lg bg-brand px-3 text-xs font-semibold text-background">
                            {t('merchant.apply')}
                          </button>
                        </div>
                      </div>
                    )}

                    {variantEdit &&
                      product.variants.some((variant) => variant.id === variantEdit.variantId) && (
                        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-background/60 p-3">
                          <label className="text-xs text-tertiary">
                            {t('merchant.sku')}
                            <input
                              value={variantEdit.sku}
                              onChange={(event) =>
                                setVariantEdit({ ...variantEdit, sku: event.target.value })
                              }
                              className="mt-1 block h-9 w-40 rounded-lg border border-border-strong bg-background px-2 text-xs"
                            />
                          </label>
                          <label className="text-xs text-tertiary">
                            {t('merchant.priceOptionalBase')}
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
                                priceCents: parseMoneyInputToCents(variantEdit.price),
                              })
                            }
                            className="inline-flex h-9 items-center rounded-full bg-brand px-3 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {t('merchant.saveVariant')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setVariantEdit(null)}
                            className="inline-flex h-9 items-center rounded-full border border-border-strong px-3 text-xs font-medium transition-colors hover:bg-surface-raised"
                          >
                            {t('merchant.cancel')}
                          </button>
                        </div>
                      )}

                    {variantProductId === product.id && (
                      <div className="mt-3 rounded-xl border border-border bg-background/60 p-3">
                        <div className="flex flex-wrap items-end gap-2">
                          {variantAxesFor(product).length === 0 ? (
                            <label className="text-xs text-tertiary">
                              {t('merchant.variantValue')}
                              <input
                                value={variantValues.__value ?? ''}
                                onChange={(event) => setVariantValues({ __value: event.target.value })}
                                placeholder={t('merchant.variantValuePlaceholder')}
                                className="mt-1 block h-9 w-56 rounded-lg border border-border-strong bg-background px-2 text-xs"
                              />
                            </label>
                          ) : (
                            variantAxesFor(product).map((axis) => (
                              <label key={axis} className="text-xs text-tertiary">
                                {axis.charAt(0).toUpperCase() + axis.slice(1)}
                                <input
                                  value={variantValues[axis] ?? ''}
                                  onChange={(event) =>
                                    setVariantValues((current) => ({ ...current, [axis]: event.target.value }))
                                  }
                                  placeholder={
                                    product.optionSchema
                                      .find((item) => item.name === axis)
                                      ?.values.join(', ') || t('merchant.variantValuePlaceholder')
                                  }
                                  className="mt-1 block h-9 w-32 rounded-lg border border-border-strong bg-background px-2 text-xs"
                                />
                              </label>
                            ))
                          )}
                          <label className="text-xs text-tertiary">
                            {t('merchant.priceOptional')}
                            <input value={variantPrice} onChange={(event) => setVariantPrice(event.target.value)} inputMode="decimal" className="mt-1 block h-9 w-24 rounded-lg border border-border-strong bg-background px-2 text-xs" />
                          </label>
                          <label className="text-xs text-tertiary">
                            {t('merchant.stock')}
                            <input value={variantStock} onChange={(event) => setVariantStock(event.target.value)} inputMode="numeric" className="mt-1 block h-9 w-20 rounded-lg border border-border-strong bg-background px-2 text-xs" />
                          </label>
                          <button type="button" onClick={() => void addVariant(product)} className="h-9 rounded-lg bg-brand px-3 text-xs font-semibold text-background">
                            {t('merchant.add')}
                          </button>
                        </div>
                        <p className="mt-2 text-[11px] text-muted">{t('merchant.variantValueHint')}</p>
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
