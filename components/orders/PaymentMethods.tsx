'use client';

import { useMemo, useState } from 'react';
import { Check, Copy, Landmark, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/components/i18n/I18nProvider';

export type PaymentMethodKey = 'yape' | 'plin' | 'bank';

export interface PublicPayments {
  yape: string | null;
  plin: string | null;
  bankAccount: string | null;
  holder: string | null;
}

interface Props {
  payments: PublicPayments;
  initialMethod?: PaymentMethodKey | 'cash' | null;
}

/** Los números de Yape/Plin se copian sin espacios; la cuenta conserva su formato. */
export function paymentCopyValue(method: PaymentMethodKey, value: string): string {
  return method === 'bank' ? value.trim() : value.replace(/\s+/g, '');
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('copy_failed');
}

/**
 * Opciones de pago manual.
 *
 * Cada opción es un botón real: al tocarla queda seleccionada y copia el dato
 * que el comprador necesita pegar en Yape, Plin o su banco. El estado visual no
 * depende de un radio nativo escondido, que era lo que hacía parecer que no se
 * seleccionaba nada.
 */
export function PaymentMethods({ payments, initialMethod }: Props) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<PaymentMethodKey | null>(null);
  const [copied, setCopied] = useState<PaymentMethodKey | null>(null);

  const options = useMemo(() => {
    const list: Array<{ key: PaymentMethodKey; value: string; label: string }> = [];
    if (payments.yape) {
      list.push({ key: 'yape', value: payments.yape, label: t('order.payYape') });
    }
    if (payments.plin) {
      list.push({ key: 'plin', value: payments.plin, label: t('order.payPlin') });
    }
    if (payments.bankAccount) {
      list.push({ key: 'bank', value: payments.bankAccount, label: t('order.payBank') });
    }
    return list;
  }, [payments.yape, payments.plin, payments.bankAccount, t]);

  const activeKey = options.some((option) => option.key === selected)
    ? selected
    : initialMethod && options.some((option) => option.key === initialMethod)
      ? initialMethod
      : (options[0]?.key ?? null);

  const selectAndCopy = async (option: (typeof options)[number]) => {
    setSelected(option.key);
    try {
      await copyText(paymentCopyValue(option.key, option.value));
      setCopied(option.key);
      toast.success(t('order.paymentCopiedToast', { method: option.label }));
      window.setTimeout(() => {
        setCopied((current) => (current === option.key ? null : current));
      }, 900);
    } catch {
      toast.error(t('order.paymentCopyFailed'));
    }
  };

  if (options.length === 0) return null;

  return (
    <div className="mt-2">
      <div className="space-y-2" role="group" aria-label={t('order.payMethodsTitle')}>
        {options.map((option) => {
          const active = activeKey === option.key;
          const justCopied = copied === option.key;
          const Icon = option.key === 'bank' ? Landmark : Smartphone;

          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={active}
              onClick={() => void selectAndCopy(option)}
              className={`flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition-colors ${
                active
                  ? 'border-brand bg-surface-raised ring-1 ring-brand/25'
                  : 'border-border bg-background hover:border-border-strong hover:bg-surface-raised/60'
              }`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                    active ? 'bg-brand text-background' : 'bg-surface-raised text-secondary'
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm text-secondary">{option.label}</span>
                  <span className="mt-0.5 block break-all font-mono text-body font-semibold tabular-nums text-primary">
                    {option.value}
                  </span>
                </span>
              </span>
              <span
                className={`inline-flex shrink-0 items-center gap-1 text-xs font-semibold ${
                  active ? 'text-success' : 'text-tertiary'
                }`}
              >
                {active ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {active
                  ? justCopied
                    ? t('order.paymentCopied')
                    : t('order.paymentSelected')
                  : t('order.paymentCopy')}
              </span>
            </button>
          );
        })}
      </div>

      {payments.holder && (
        <p className="mt-2 px-1 text-xs text-tertiary">
          {t('order.payHolder')}:{' '}
          <span className="font-medium text-secondary">{payments.holder}</span>
        </p>
      )}
    </div>
  );
}
