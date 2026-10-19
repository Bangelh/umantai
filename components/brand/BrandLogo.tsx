/**
 * components/brand/BrandLogo.tsx — slot del logo oficial de UMANTAI.
 *
 * El cliente todavía no entregó el archivo definitivo. NO se inventa un logo:
 *   1. Si existe `public/brand/umantai-logo.svg`, se usa ese archivo.
 *   2. Si no, se muestra el wordmark tipográfico actual ("umantai").
 *
 * Para publicar el logo definitivo alcanza con copiar el SVG a
 * `public/brand/umantai-logo.svg` (ver public/brand/README.md). No hay que tocar
 * componentes ni estilos.
 *
 * Funciona en claro y oscuro: el SVG debe usar `currentColor` o tener sus
 * propios contrastes; el wordmark hereda el color del texto.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

const LOGO_FILE = path.join(process.cwd(), 'public', 'brand', 'umantai-logo.svg');
const LOGO_URL = '/brand/umantai-logo.svg';

export function BrandLogo({
  className = '',
  size = 'md',
}: {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const height = size === 'lg' ? 40 : size === 'sm' ? 22 : 28;
  const hasLogo = existsSync(LOGO_FILE);

  if (hasLogo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- asset local del cliente, sin dimensiones conocidas
      <img
        src={LOGO_URL}
        alt="UMANTAI"
        height={height}
        className={`w-auto ${className}`}
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
