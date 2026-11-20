'use client';

/**
 * components/ui/SpotlightSurface.tsx — superficie con luz que sigue al puntero.
 *
 * Patrón tomado de Watermelon UI / Motion Primitives, reescrito sobre los
 * tokens de UMANTAI y sin dependencias fuera de `motion`:
 *
 *   · Una luz radial muy baja (14 % de marca) sigue al cursor. No colorea el
 *     contenido: el texto conserva el contraste que ya estaba validado.
 *   · Un filo superior de 1 px insinúa la elevación sin sombra pesada.
 *   · Con `prefers-reduced-motion` o sin puntero fino, la luz no se dibuja y
 *     el bloque queda idéntico al `surface-card` habitual.
 *
 * Solo se animan `background` de una capa `aria-hidden`; el layout del hijo no
 * cambia, así que no hay reflow en `mousemove`.
 */
import { useCallback, useRef } from 'react';
import { motion, useMotionTemplate, useMotionValue, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

export function SpotlightSurface({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const background = useMotionTemplate`radial-gradient(420px circle at ${x}px ${y}px, color-mix(in srgb, var(--um-brand) 14%, transparent), transparent 72%)`;

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (reduced) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      x.set(event.clientX - rect.left);
      y.set(event.clientY - rect.top);
    },
    [reduced, x, y],
  );

  return (
    <div
      ref={containerRef}
      onPointerMove={onPointerMove}
      className={`group relative overflow-hidden ${className}`}
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent"
      />
      {!reduced && (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-within:opacity-100"
          style={{ background }}
        />
      )}
      <div className="relative">{children}</div>
    </div>
  );
}
