/**
 * components/brand/BrandLogo.tsx — logo oficial de UMANTAI.
 *
 * El archivo vive en `public/brand/umantai-logo.png` (convertido desde el SVG
 * entregado por el cliente). Es negro sobre fondo transparente, así que en el
 * tema oscuro se invierte con la clase `brand-logo-img` definida en globals.css.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

const LOGO_FILE = path.join(process.cwd(), 'public', 'brand', 'umantai-logo.png');
const LOGO_URL = '/brand/umantai-logo.png';

export function BrandLogo({
  className = '',
  size = 'md',
}: {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const height = size === 'lg' ? 56 : size === 'sm' ? 28 : 48;

  if (existsSync(LOGO_FILE)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- asset local del cliente, sin dimensiones conocidas
      <img
        src={LOGO_URL}
        alt="UMANTAI"
        height={height}
        className={`brand-logo-img w-auto ${className}`}
        style={{ height }}
      />
    );
  }

  return (
    <span
      aria-label="UMANTAI"
      className={`font-semibold tracking-[-1px] text-primary ${
        size === 'lg' ? 'text-4xl' : size === 'sm' ? 'text-xl' : 'text-2xl'
      } ${className}`}
    >
      umantai
    </span>
  );
}
