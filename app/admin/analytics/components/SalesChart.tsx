'use client';

import { useI18n } from '@/components/i18n/I18nProvider';
import type { AnalyticsPoint } from '@/lib/analytics';
import { formatDate, formatMoney } from '@/lib/format';

interface SalesChartProps {
  points: AnalyticsPoint[];
  title: string;
  /** 'daily' | 'weekly' — solo para el texto accesible del eje. */
  granularity: 'daily' | 'weekly';
}

const WIDTH = 800;
const HEIGHT = 260;
const PADDING = { top: 16, right: 12, bottom: 34, left: 64 };

/**
 * Gráfico de ventas en el tiempo.
 *
 * SVG propio en vez de una librería: es una sola serie de barras, y una librería
 * de charts agregaría ~40–100 KB para dibujar lo mismo. Sin dependencias nuevas.
 *
 * Accesibilidad: el SVG es decorativo (`aria-hidden`) y debajo hay una tabla
 * `sr-only` con los mismos datos, más un resumen textual del pico.
 */
export function SalesChart({ points, title, granularity }: SalesChartProps) {
  const { locale, t } = useI18n();
  const money = (cents: number) => formatMoney(cents, 'PEN', locale);
  const shortDate = (value: string) => formatDate(value, locale, { month: 'short', day: 'numeric' });
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;

  const max = Math.max(0, ...points.map((point) => point.revenueCents));
  const hasSales = max > 0;
  const step = points.length > 0 ? plotWidth / points.length : plotWidth;
  const barWidth = Math.max(2, Math.min(28, step * 0.62));

  const peak = points.reduce<AnalyticsPoint | null>(
    (best, point) => (!best || point.revenueCents > best.revenueCents ? point : best),
    null,
  );

  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const gridLines = [0, 0.5, 1].map((ratio) => ({
    y: PADDING.top + plotHeight - plotHeight * ratio,
    value: Math.round(max * ratio),
  }));

  const speakGranularity = granularity === 'daily' ? 'por día' : 'por semana';

  return (
    <div className="surface-card p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium">{title}</h2>
        <p className="text-sm text-tertiary">
          {hasSales && peak
            ? t(granularity === 'daily' ? 'analytics.bestDay' : 'analytics.bestWeek', {
                date: shortDate(peak.date),
                value: money(peak.revenueCents),
              })
            : 'Sin ventas en el período'}
        </p>
      </div>

      <p className="sr-only">
        Gráfico de ventas {speakGranularity}. {points.length} barras.
        {peak && hasSales
          ? t('analytics.peakSuffix', { value: money(peak.revenueCents), date: peak.date })
          : ' No hay ventas en el período.'}
      </p>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mt-4 h-auto w-full"
        role="presentation"
        aria-hidden="true"
        focusable="false"
      >
        {gridLines.map((line) => (
          <g key={line.y}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={line.y}
              y2={line.y}
              stroke="var(--um-border)"
              strokeDasharray={line.value === 0 ? undefined : '3 5'}
            />
            <text
              x={PADDING.left - 10}
              y={line.y + 4}
              textAnchor="end"
              fontSize="11"
              fill="var(--um-tertiary)"
            >
              {money(line.value)}
            </text>
          </g>
        ))}

        {points.map((point, index) => {
          const height = max > 0 ? (point.revenueCents / max) * plotHeight : 0;
          const x = PADDING.left + index * step + (step - barWidth) / 2;
          const y = PADDING.top + plotHeight - height;
          return (
            <g key={point.date}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(height, point.revenueCents > 0 ? 1.5 : 0)}
                rx={Math.min(4, barWidth / 2)}
                fill={point.revenueCents > 0 ? 'var(--um-brand)' : 'var(--um-border)'}
                opacity={point.revenueCents > 0 ? 0.9 : 0.35}
              >
                <title>
                  {t('analytics.pointTitle', {
                    date: point.date,
                    value: money(point.revenueCents),
                    count: point.orders,
                  })}
                </title>
              </rect>
              {index % labelEvery === 0 && (
                <text
                  x={x + barWidth / 2}
                  y={HEIGHT - 12}
                  textAnchor="middle"
                  fontSize="11"
                  fill="var(--um-tertiary)"
                >
                  {shortDate(point.date)}
                </text>
              )}
            </g>
          );
        })}

        <line
          x1={PADDING.left}
          x2={WIDTH - PADDING.right}
          y1={PADDING.top + plotHeight}
          y2={PADDING.top + plotHeight}
          stroke="var(--um-border-strong)"
        />
      </svg>

      <table className="sr-only">
        <caption>Ventas {speakGranularity}</caption>
        <thead>
          <tr>
            <th scope="col">{t('analytics.date')}</th>
            <th scope="col">{t('analytics.orders')}</th>
            <th scope="col">{t('analytics.revenueShort')}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.date}>
              <th scope="row">{point.date}</th>
              <td>{point.orders}</td>
              <td>{money(point.revenueCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
