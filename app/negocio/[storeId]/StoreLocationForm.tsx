'use client';

/**
 * StoreLocationForm — completa o corrige la ubicación de una tienda.
 *
 * La lógica del asistente vive en `components/map/LocationPicker`; acá solo se
 * persiste con `PATCH /api/merchant/stores/<id>` y se refresca el panel.
 *
 * El servidor valida el UBIGEO contra el catálogo, exige el pin dentro del Perú
 * y deriva departamento/provincia/distrito. La publicación sigue dependiendo de
 * la revisión de un administrador: este formulario NO activa la tienda.
 */

import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { useI18n } from '@/components/i18n/I18nProvider';
import { LocationPicker, type StoreLocationValue } from '@/components/map/LocationPicker';

interface Props {
  storeId: string;
  initial?: Partial<StoreLocationValue> | null;
}

export function StoreLocationForm({ storeId, initial }: Props) {
  const { t } = useI18n();
  const router = useRouter();

  const submit = async (value: StoreLocationValue): Promise<string | undefined> => {
    try {
      const response = await fetch(`/api/merchant/stores/${storeId}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: value }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; code?: string; warnings?: string[] }
        | null;

      if (!response.ok) {
        return payload?.error ?? t('location.saveFailed');
      }

      toast.success(t('location.saved'));
      if (payload?.warnings?.includes('pin_far_from_district')) {
        toast.message(t('location.farWarning'));
      }
      router.refresh();
      return undefined;
    } catch {
      return t('location.saveFailed');
    }
  };

  return <LocationPicker initial={initial ?? null} onSubmit={submit} submitLabel={t('location.confirm')} />;
}
