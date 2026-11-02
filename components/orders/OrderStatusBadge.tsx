/**
 * components/orders/OrderStatusBadge.tsx — badge único de estado de pedido.
 *
 * El tono sale de `lib/order-status-copy.ts` y las clases viven acá (no en `lib/`)
 * para que Tailwind las encuentre al escanear el código fuente.
 */

import { orderStatusCopy, type OrderTone } from '@/lib/order-status-copy';

const TONE_CLASSES: Record<OrderTone, string> = {
  attention: 'border-warning/40 bg-warning/10 text-warning',
  progress: 'border-info/40 bg-info/10 text-info',
  success: 'border-success/40 bg-success/10 text-success',
  neutral: 'border-border-strong bg-surface-raised text-secondary',
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
};

export function OrderStatusBadge({
  status,
  label,
  size = 'sm',
}: {
  status: string;
  label: string;
  size?: 'sm' | 'lg';
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border font-medium ${TONE_CLASSES[orderStatusCopy(status).tone]} ${
        size === 'lg' ? 'px-4 py-1 text-body' : 'px-2.5 py-0.5 text-xs'
      }`}
    >
      {label}
    </span>
  );
}
