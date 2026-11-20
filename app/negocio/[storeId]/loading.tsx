import { AuroraBackdrop } from '@/components/ui/AuroraBackdrop';
import { getTranslator } from '@/lib/i18n/server';

/**
 * Mientras el panel resuelve membresía, productos y pedidos, mostramos la misma
 * estructura que va a aparecer. Evita el salto de layout y deja claro que la
 * pantalla sigue cargando.
 */
export default async function MerchantStoreLoading() {
  const { t } = await getTranslator();

  return (
    <main
      aria-busy="true"
      aria-label={t('merchant.loading')}
      className="mx-auto max-w-5xl animate-pulse px-4 pb-12 pt-6 sm:px-6"
    >
      <div aria-hidden="true" className="h-3 w-36 rounded bg-surface-raised" />

      <div className="relative isolate -mx-4 px-4 pb-1 sm:-mx-6 sm:px-6">
      <AuroraBackdrop />
      <div aria-hidden="true" className="surface-card relative mt-4 flex flex-wrap items-start justify-between gap-4 p-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="h-14 w-14 shrink-0 rounded-2xl bg-surface-raised" />
          <div className="min-w-0 space-y-2">
            <div className="h-2.5 w-24 rounded bg-surface-raised" />
            <div className="h-7 w-48 rounded bg-surface-raised" />
            <div className="h-3 w-32 rounded bg-surface-raised" />
            <div className="h-6 w-24 rounded-full bg-surface-raised" />
          </div>
        </div>
        <div className="flex gap-2">
          <div className="h-9 w-24 rounded-xl bg-surface-raised" />
          <div className="h-9 w-24 rounded-xl bg-surface-raised" />
        </div>
      </div>
      </div>

      <div aria-hidden="true" className="mt-4 flex gap-2 overflow-hidden">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="h-10 w-24 shrink-0 rounded-full bg-surface-raised" />
        ))}
      </div>

      <div aria-hidden="true" className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="rounded-2xl border border-border bg-surface p-3 sm:p-4">
            <div className="h-9 w-10 rounded bg-surface-raised" />
            <div className="mt-2 h-3 w-24 rounded bg-surface-raised" />
          </div>
        ))}
      </div>

      <div aria-hidden="true" className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="rounded-xl border border-border bg-surface p-3">
            <div className="h-2.5 w-20 rounded bg-surface-raised" />
            <div className="mt-2 h-6 w-24 rounded bg-surface-raised" />
          </div>
        ))}
      </div>

      <div aria-hidden="true" className="mt-8">
        <div className="flex items-center justify-between border-b border-border pb-2">
          <div className="h-4 w-24 rounded bg-surface-raised" />
          <div className="h-3 w-6 rounded bg-surface-raised" />
        </div>
        <div className="mt-3 space-y-2">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex min-h-16 items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-28 rounded bg-surface-raised" />
                <div className="h-3 w-40 rounded bg-surface-raised" />
                <div className="h-3 w-24 rounded bg-surface-raised" />
              </div>
              <div className="h-4 w-20 rounded bg-surface-raised" />
            </div>
          ))}
        </div>
      </div>

      <div aria-hidden="true" className="mt-8">
        <div className="h-4 w-28 rounded bg-surface-raised" />
        <div className="mt-3 h-32 rounded-2xl border border-border bg-surface" />
      </div>
    </main>
  );
}
