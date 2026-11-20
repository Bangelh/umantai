'use client';

/**
 * components/ui/Reveal.tsx — entrada sutil al entrar en viewport.
 *
 * Adaptado del patrón `AnimatedGroup` de Motion Primitives, recortado a lo que
 * UMANTAI necesita: un solo gesto (opacidad + 12 px de desplazamiento) y nada
 * más. Se anima `transform`/`opacity`, nunca `height` ni `top`.
 *
 * Reglas:
 *   · Con `prefers-reduced-motion`, el contenido se renderiza visible desde el
 *     primer frame (sin animación y sin `opacity: 0` que dependa de JS).
 *   · `once` evita que la página "parpadee" cada vez que se vuelve a hacer
 *     scroll sobre la misma sección.
 *   · El retardo se acota para que una lista larga no tarde en aparecer.
 */
import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

const EASE = [0.22, 1, 0.36, 1] as const;

export function Reveal({
  children,
  delay = 0,
  y = 12,
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();

  if (reduced) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -48px 0px' }}
      transition={{ duration: 0.45, delay: Math.min(delay, 0.24), ease: EASE }}
    >
      {children}
    </motion.div>
  );
}
