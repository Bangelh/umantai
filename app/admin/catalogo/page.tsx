'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/components/i18n/I18nProvider';
import { withAdminAuth } from '@/lib/adminAuth';
import { AdminAccessScreen } from '@/components/admin/AdminAccessScreen';
import { usePlatformAdminSession } from '@/lib/usePlatformAdminSession';

interface MasterHit {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  imageUrl: string | null;
  archivedAt: string | null;
}

interface CatalogFacets {
  categories: string[];
  brands: string[];
}

interface CatalogSnapshot {
  products: MasterHit[];
  /** `null` cuando los facets fallaron: se conservan los que ya estaban. */
  facets: CatalogFacets | null;
}

/**
 * Petición pura del catálogo maestro: no toca estado de React. La usan el efecto
 * de carga inicial (que aplica la respuesta en su callback) y `load`, que sí
 * actualiza estado porque lo dispara un evento del usuario.
 */
async function requestCatalog(params: URLSearchParams): Promise<CatalogSnapshot> {
  const response = await fetch(
    `/api/admin/master-products?${params.toString()}`,
    withAdminAuth(),
  );
  const payload = (await response.json().catch(() => null)) as {
    products?: MasterHit[];
    error?: string;
  } | null;
  if (!response.ok) throw new Error(payload?.error ?? 'No autorizado.');

  const products = payload?.products ?? [];
  const facetResponse = await fetch('/api/admin/master-products/facets', withAdminAuth());
  if (!facetResponse.ok) return { products, facets: null };

  const facetPayload = (await facetResponse.json().catch(() => null)) as {
    categories?: string[];
    brands?: string[];
  } | null;
  return {
    products,
    facets: {
      categories: facetPayload?.categories ?? [],
      brands: facetPayload?.brands ?? [],
    },
  };
}

/**
 * /admin/catalogo — Platform Admin (catálogo maestro global).
 *
 * Separado del panel del comerciante: acá se define el producto canónico; el
 * precio/stock/publicación vive en cada StoreProduct. Protegido por la sesión de
 * Platform Admin (cookie firmada); el token compartido ya no se pide en la UI.
 */
export default function MasterCatalogPage() {
  const { t } = useI18n();
  const admin = usePlatformAdminSession();
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<MasterHit[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [filterCategory, setFilterCategory] = useState('');
  const [filterBrand, setFilterBrand] = useState('');
  const [facets, setFacets] = useState<{ categories: string[]; brands: string[] }>({
    categories: [],
    brands: [],
  });

  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editBrand, setEditBrand] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editDescription, setEditDescription] = useState('');

  // Sólo para acciones del usuario: marca `busy` de inmediato porque no corre
  // dentro de un efecto.
  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        q: query,
        includeArchived: showArchived ? '1' : '0',
      });
      if (filterCategory) params.set('category', filterCategory);
      if (filterBrand) params.set('brand', filterBrand);

      const snapshot = await requestCatalog(params);
      setProducts(snapshot.products);
      if (snapshot.facets) setFacets(snapshot.facets);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No autorizado.');
    } finally {
      setBusy(false);
    }
  }, [filterBrand, filterCategory, query, showArchived]);

  // Carga inicial al activarse la sesión de Platform Admin. El estado se aplica
  // en el callback de la promesa (nunca de forma síncrona dentro del efecto) y
  // se descarta si la sesión cambió o el componente se desmontó.
  useEffect(() => {
    if (admin.status !== 'authenticated') return;
    let cancelled = false;
    // Primer listado sin filtros: es el estado inicial del panel.
    void requestCatalog(new URLSearchParams({ q: '', includeArchived: '0' }))
      .then((snapshot) => {
        if (cancelled) return;
        setProducts(snapshot.products);
        if (snapshot.facets) setFacets(snapshot.facets);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'No autorizado.');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [admin.status]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(
        '/api/admin/master-products',
        withAdminAuth({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            brand: brand.trim() || null,
            category: category.trim() || null,
            description: description.trim() || null,
          }),
        }),
      );
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'No se pudo crear.');
      setName('');
      setBrand('');
      setCategory('');
      setDescription('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear.');
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (product: MasterHit) => {
    setEditingId(product.id);
    setEditName(product.name);
    setEditBrand(product.brand ?? '');
    setEditCategory(product.category ?? '');
    setEditDescription(product.description ?? '');
  };

  const saveEdit = async (product: MasterHit) => {
    if (!editName.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(
        '/api/admin/master-products',
        withAdminAuth({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: product.id,
            name: editName.trim(),
            brand: editBrand.trim(),
            category: editCategory.trim(),
            description: editDescription.trim(),
            active: !product.archivedAt,
          }),
        }),
      );
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'No se pudo guardar.');
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  };

  const archive = async (product: MasterHit) => {
    if (!window.confirm(t('catalog.archiveConfirm', { name: product.name }))) return;
    setBusy(true);
    try {
      const response = await fetch(
        '/api/admin/master-products',
        withAdminAuth({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: product.id, archived: true }),
        }),
      );
      if (!response.ok) throw new Error('No se pudo archivar.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo archivar.');
    } finally {
      setBusy(false);
    }
  };

  const upload = async (product: MasterHit, file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('masterProductId', product.id);
      const response = await fetch('/api/admin/media', withAdminAuth({ method: 'POST', body: form }));
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'No se pudo subir.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo subir.');
    } finally {
      setBusy(false);
    }
  };

  if (admin.status !== 'authenticated') {
    return (
      <AdminAccessScreen
        title={t('catalog.title')}
        status={admin.status}
        onActivate={admin.activate}
      />
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-xs uppercase tracking-[2px] text-muted">{t('catalog.kicker')}</p>
          <h1 className="mt-1 text-2xl font-semibold">{t('catalog.title')}</h1>
          <p className="mt-1 text-sm text-tertiary">{t('catalog.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Link href="/admin" className="inline-flex h-9 items-center rounded-xl border border-border-strong px-3 text-sm">
            {t('catalog.legacyPanel')}
          </Link>
          <button
            type="button"
            onClick={() => void admin.signOut()}
            className="h-9 rounded-xl border border-border px-3 text-xs text-tertiary"
          >
            {t('admin.signOut')}
          </button>
        </div>
      </div>

      {error && <p className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

      <form onSubmit={create} className="mt-5 rounded-2xl border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold">{t('catalog.newProduct')}</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-tertiary">
            {t('catalog.canonicalName')}
            <input value={name} onChange={(event) => setName(event.target.value)} required className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm" />
          </label>
          <label className="text-xs text-tertiary">
            {t('catalog.brand')}
            <input value={brand} onChange={(event) => setBrand(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm" />
          </label>
          <label className="text-xs text-tertiary">
            {t('catalog.category')}
            <input value={category} onChange={(event) => setCategory(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm" />
          </label>
          <label className="text-xs text-tertiary sm:col-span-2">
            {t('catalog.baseDescription')}
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} className="mt-1 w-full rounded-xl border border-border-strong bg-background px-3 py-2 text-sm" />
          </label>
        </div>
        <button type="submit" disabled={busy} className="mt-3 h-10 rounded-xl bg-brand px-4 text-sm font-semibold text-background disabled:opacity-50">
          {t('catalog.createMaster')}
        </button>
      </form>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('catalog.searchPlaceholder')}
          className="h-10 min-w-40 flex-1 rounded-xl border border-border-strong bg-background px-3 text-sm"
        />
        <select
          value={filterCategory}
          onChange={(event) => setFilterCategory(event.target.value)}
          aria-label={t('catalog.filterCategory')}
          className="h-10 rounded-xl border border-border-strong bg-background px-2 text-xs"
        >
          <option value="">{t('catalog.allCategories')}</option>
          {facets.categories.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <select
          value={filterBrand}
          onChange={(event) => setFilterBrand(event.target.value)}
          aria-label={t('catalog.filterBrand')}
          className="h-10 rounded-xl border border-border-strong bg-background px-2 text-xs"
        >
          <option value="">{t('catalog.allBrands')}</option>
          {facets.brands.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-tertiary">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          {t('catalog.showArchived')}
        </label>
        <button type="button" onClick={() => void load()} disabled={busy} className="h-10 rounded-xl border border-border-strong px-3 text-sm">
          {t('catalog.search')}
        </button>
        <span className="text-xs text-muted tabular-nums">{products.length}</span>
      </div>

      <ul className="divide-y divide-border">
        {products.map((product) => (
          <li key={product.id} className="flex items-start gap-3 py-3">
            {product.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- imagen del catálogo maestro
              <img src={product.imageUrl} alt="" className="h-12 w-12 rounded-lg border border-border object-cover" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-surface-raised text-sm font-semibold text-tertiary">
                {product.name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium">{product.name}</span>
                {product.archivedAt && (
                  <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted">
                    {t('catalog.archived')}
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-tertiary">
                {[product.brand, product.category].filter(Boolean).join(' · ') || 'Sin marca'}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <button
                type="button"
                onClick={() => (editingId === product.id ? setEditingId(null) : startEdit(product))}
                className="text-xs text-secondary hover:text-primary"
              >
                {editingId === product.id ? 'Cerrar' : 'Editar'}
              </button>
              <label className="cursor-pointer text-xs text-secondary hover:text-primary">
                Imagen
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void upload(product, file);
                    event.target.value = '';
                  }}
                />
              </label>
              {!product.archivedAt && (
                <button type="button" onClick={() => void archive(product)} className="text-xs text-destructive/80 hover:text-destructive">
                  {t('catalog.archive')}
                </button>
              )}
            </div>

            {editingId === product.id && (
              <div className="mt-2 w-full rounded-xl border border-border bg-surface p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-tertiary">
                    {t('catalog.canonicalName')}
                    <input value={editName} onChange={(event) => setEditName(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-border-strong bg-background px-2 text-sm" />
                  </label>
                  <label className="text-xs text-tertiary">
                    {t('catalog.brand')}
                    <input value={editBrand} onChange={(event) => setEditBrand(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-border-strong bg-background px-2 text-sm" />
                  </label>
                  <label className="text-xs text-tertiary">
                    {t('catalog.category')}
                    <input value={editCategory} onChange={(event) => setEditCategory(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-border-strong bg-background px-2 text-sm" />
                  </label>
                  <label className="text-xs text-tertiary sm:col-span-2">
                    {t('catalog.baseDescription')}
                    <textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} rows={2} className="mt-1 w-full rounded-lg border border-border-strong bg-background px-2 py-1.5 text-sm" />
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => void saveEdit(product)}
                  disabled={busy}
                  className="mt-2 h-9 rounded-lg bg-brand px-3 text-xs font-semibold text-background disabled:opacity-50"
                >
                  {t('catalog.saveChanges')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
