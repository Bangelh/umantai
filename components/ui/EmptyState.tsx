import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * components/ui/EmptyState.tsx — estado vacío compartido.
 *
 * Un vacío no es solo "no hay datos": tiene que explicar por qué está vacío y
 * cuál es el siguiente paso. El icono y la superficie son deliberadamente
 * sobrios para que la acción siga siendo lo más visible.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  align = 'start',
  compact = false,
  className = '',
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  align?: 'start' | 'center';
  compact?: boolean;
  className?: string;
}) {
  const centered = align === 'center';
  const padding = compact ? 'p-4' : 'p-5 sm:p-7';

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-dashed border-border-strong bg-surface/60 ${padding} ${className}`}
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent"
      />
      <div
        className={`relative flex gap-3 ${centered ? 'flex-col items-center text-center' : 'items-start'}`}
      >
        {Icon && (
          <span
            className={`flex shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-raised text-secondary ${
              compact ? 'h-9 w-9' : 'h-11 w-11'
            }`}
          >
            <Icon aria-hidden="true" className={compact ? 'h-4 w-4' : 'h-5 w-5'} strokeWidth={1.75} />
          </span>
        )}
        <div className={centered ? 'flex flex-col items-center' : 'min-w-0'}>
          <p className={`${compact ? 'text-body' : 'text-body-lg'} font-semibold text-primary`}>
            {title}
          </p>
          {description && (
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-secondary">{description}</p>
          )}
          {action && (
            <div className={`mt-4 flex flex-wrap gap-2 ${centered ? 'justify-center' : ''}`}>
              {action}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
