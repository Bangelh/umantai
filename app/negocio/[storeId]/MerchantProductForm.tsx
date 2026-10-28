'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';
import { unitsToCents } from '@/lib/format';

export function MerchantProductForm({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('');
  const [brand, setBrand] = useState('');
  const [stock, setStock] = useState('0');
  const [unit, setUnit] = useState('unidad');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const priceValue = Number(price.replace(',', '.'));
    if (!name.trim()) {
      toast.error(t('merchant.nameRequired'));
      return;
    }
    if (!Number.isFinite(priceValue) || priceValue < 0) {
      toast.error(t('merchant.invalidPrice'));
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`/api/merchant/stores/${storeId}/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          priceCents: unitsToCents(priceValue),
          category: category.trim() || null,
          brand: brand.trim() || null,
          unit: unit.trim() || 'unidad',
          initialStock: Math.max(0, Math.floor(Number(stock) || 0)),
        }),
      });

      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? t('merchant.createProductFailed'));

      toast.success(t('merchant.productAdded'));
      setName('');
      setPrice('');
      setCategory('');
      setBrand('');
      setStock('0');
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('merchant.createProductFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex h-10 items-center rounded-xl border border-border-strong px-4 text-sm font-medium hover:bg-surface-raised"
      >
        {t('merchant.addProduct')}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 rounded-2xl border border-border bg-surface p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs text-tertiary sm:col-span-2">
          {t('merchant.name')}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={160}
            required
            className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          />
        </label>

        <label className="text-xs text-tertiary">
          {t('merchant.pricePEN')}
          <input
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            inputMode="decimal"
            placeholder="12.50"
            required
            className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          />
        </label>

        <label className="text-xs text-tertiary">
          {t('merchant.initialStockShort')}
          <input
            value={stock}
            onChange={(event) => setStock(event.target.value)}
            inputMode="numeric"
            className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          />
        </label>

        <label className="text-xs text-tertiary">
          {t('merchant.category')}
          <input
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            maxLength={60}
            className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          />
        </label>

        <label className="text-xs text-tertiary">
          {t('merchant.brandOptional')}
          <input
            value={brand}
            onChange={(event) => setBrand(event.target.value)}
            maxLength={60}
            className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          />
        </label>

        <label className="text-xs text-tertiary">
          {t('merchant.saleUnit')}
          <select
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          >
            <option value="unidad">{t('merchant.unitUnit')}</option>
            <option value="kg">{t('merchant.unitKg')}</option>
            <option value="metro">{t('merchant.unitMeter')}</option>
            <option value="litro">{t('merchant.unitLiter')}</option>
            <option value="paquete">{t('merchant.unitPack')}</option>
          </select>
        </label>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="h-10 rounded-xl bg-brand px-4 text-sm font-semibold text-background disabled:opacity-50"
        >
          {submitting ? t('merchant.saving') : t('merchant.saveProduct')}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="h-10 rounded-xl border border-border-strong px-4 text-sm hover:bg-surface-raised"
        >
          {t('merchant.cancel')}
        </button>
      </div>
    </form>
  );
}
