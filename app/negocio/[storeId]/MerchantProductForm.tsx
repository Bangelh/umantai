'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export function MerchantProductForm({ storeId }: { storeId: string }) {
  const router = useRouter();
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
      toast.error('El nombre es obligatorio.');
      return;
    }
    if (!Number.isFinite(priceValue) || priceValue < 0) {
      toast.error('Ingresa un precio válido.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`/api/merchant/stores/${storeId}/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          priceCents: Math.round(priceValue * 100),
          category: category.trim() || null,
          brand: brand.trim() || null,
          unit: unit.trim() || 'unidad',
          initialStock: Math.max(0, Math.floor(Number(stock) || 0)),
        }),
      });

      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? 'No se pudo crear el producto.');

      toast.success('Producto agregado');
      setName('');
      setPrice('');
      setCategory('');
      setBrand('');
      setStock('0');
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No se pudo crear el producto.');
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
        + Agregar producto
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 rounded-2xl border border-border bg-surface p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs text-tertiary sm:col-span-2">
          Nombre
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={160}
            required
            className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          />
        </label>

        <label className="text-xs text-tertiary">
          Precio (S/)
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
          Stock inicial
          <input
            value={stock}
            onChange={(event) => setStock(event.target.value)}
            inputMode="numeric"
            className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          />
        </label>

        <label className="text-xs text-tertiary">
          Categoría
          <input
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            maxLength={60}
            className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          />
        </label>

        <label className="text-xs text-tertiary">
          Marca (opcional)
          <input
            value={brand}
            onChange={(event) => setBrand(event.target.value)}
            maxLength={60}
            className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          />
        </label>

        <label className="text-xs text-tertiary">
          Unidad de venta
          <select
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            className="mt-1 h-10 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          >
            <option value="unidad">unidad</option>
            <option value="kg">kg</option>
            <option value="metro">metro</option>
            <option value="litro">litro</option>
            <option value="paquete">paquete</option>
          </select>
        </label>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="h-10 rounded-xl bg-brand px-4 text-sm font-semibold text-background disabled:opacity-50"
        >
          {submitting ? 'Guardando…' : 'Guardar producto'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="h-10 rounded-xl border border-border-strong px-4 text-sm hover:bg-surface-raised"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
