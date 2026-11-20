'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { useI18n } from '@/components/i18n/I18nProvider';

const MAX_HOURS = 120;

/**
 * Horario de atención de la tienda.
 *
 * Se guarda como texto libre en `stores.metadata.hours` (igual que los datos de
 * pago) y se muestra en el pie público junto al WhatsApp. Texto y no una matriz
 * de lunes a domingo a propósito: cada negocio escribe su horario real —turnos
 * partidos, feriados, "solo con cita"— sin que la app invente una estructura.
 */
export function StoreHoursForm({
  storeId,
  initialHours,
}: {
  storeId: string;
  initialHours: string | null;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [hours, setHours] = useState(initialHours ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/merchant/stores/${storeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: hours.trim() || null }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) throw new Error(payload?.error ?? t('merchant.hoursInvalid'));
      toast.success(t('merchant.hoursSaved'));
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('merchant.hoursInvalid'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div>
        <label htmlFor="store-hours" className="field-label">
          {t('merchant.hoursLabel')}
        </label>
        <input
          id="store-hours"
          type="text"
          value={hours}
          onChange={(event) => setHours(event.target.value)}
          placeholder={t('merchant.hoursPlaceholder')}
          maxLength={MAX_HOURS}
          autoComplete="off"
          className="h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-body text-primary placeholder:text-muted focus:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        />
        <p className="mt-1 text-[11px] text-muted tabular-nums">
          {hours.length}/{MAX_HOURS}
        </p>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className="btn-primary w-full text-sm sm:w-auto">
        {busy ? t('merchant.hoursSaving') : t('merchant.hoursSave')}
      </button>
    </form>
  );
}
