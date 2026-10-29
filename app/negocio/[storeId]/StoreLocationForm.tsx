'use client';

/**
 * Completa la ubicación de una tienda que quedó sin coordenadas en el alta.
 *
 * Sin latitud/longitud el constraint `stores_active_location_chk` impide
 * activarla, así que la tienda queda invisible para siempre. Este formulario es
 * la acción concreta que la UI de estado ofrece al comerciante; la publicación
 * sigue dependiendo de la revisión de un administrador.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';
import { LOCATION_PRESETS } from '@/lib/locations';

interface Props {
  storeId: string;
}

export function StoreLocationForm({ storeId }: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const [zoneId, setZoneId] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    if (!zoneId) {
      toast.error(t('merchant.locationRequired'));
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(`/api/merchant/stores/${storeId}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zoneId }),
      });
      if (!response.ok) throw new Error('location_save_failed');
      toast.success(t('merchant.locationSaved'));
      router.refresh();
    } catch {
      toast.error(t('merchant.locationFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-3">
      <label htmlFor="store-zone" className="min-w-[220px] flex-1 text-xs text-tertiary">
        {t('merchant.locationZone')}
        <select
          id="store-zone"
          value={zoneId}
          onChange={(event) => setZoneId(event.target.value)}
          className="mt-1 h-11 w-full rounded-xl border border-border-strong bg-background px-3 text-sm text-primary"
          required
        >
          <option value="">{t('merchant.locationSelect')}</option>
          {LOCATION_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label} · {preset.region}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={saving}
        className="h-11 rounded-xl bg-brand px-4 text-sm font-semibold text-background disabled:opacity-50"
      >
        {saving ? t('merchant.locationSaving') : t('merchant.locationSave')}
      </button>
    </form>
  );
}
