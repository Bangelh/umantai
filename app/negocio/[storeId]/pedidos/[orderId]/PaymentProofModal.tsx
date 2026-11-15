'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/components/i18n/I18nProvider';

/**
 * Captura del pago dentro de la misma pestaña.
 *
 * Antes el `<a target="_blank">` sacaba al comerciante del panel y perdía el
 * contexto del pedido. Ahora se abre un diálogo: tocar fuera cierra, el botón
 * alterna zoom y Escape también cierra.
 */
export function PaymentProofModal({
  url,
  label,
  openLabel,
}: {
  url: string;
  label: string;
  openLabel: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setZoomed(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setZoomed(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative mt-3 block w-full overflow-hidden rounded-xl border border-border bg-background"
        aria-label={openLabel}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- captura subida por el cliente */}
        <img
          src={url}
          alt={label}
          className="max-h-80 w-full object-contain"
        />
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3 text-left text-sm font-medium text-white">
          {openLabel} · {t('merchant.proofOpenHint')}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={close}
        >
          <button
            type="button"
            onClick={close}
            className="absolute right-4 top-4 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-2xl text-white backdrop-blur hover:bg-white/25"
            aria-label={t('common.close')}
          >
            ×
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setZoomed((value) => !value);
            }}
            className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-white px-5 py-2 text-sm font-semibold text-black shadow-lg"
          >
            {zoomed ? t('merchant.proofZoomOut') : t('merchant.proofZoomIn')}
          </button>
          <div
            className="max-h-[85vh] max-w-[92vw] overflow-auto"
            onClick={(event) => event.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- captura subida por el cliente */}
            <img
              src={url}
              alt={label}
              onClick={() => setZoomed((value) => !value)}
              className={`rounded-lg bg-white object-contain transition-transform ${
                zoomed ? 'max-w-none scale-150 cursor-zoom-out' : 'max-h-[85vh] cursor-zoom-in'
              }`}
            />
          </div>
        </div>
      )}
    </>
  );
}
