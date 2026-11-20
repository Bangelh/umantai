/**
 * components/ui/AuroraBackdrop.tsx — atmósfera del hero.
 *
 * Composición al estilo Haikei: dos blobs difusos enfrentados, una retícula
 * tenue y un degradado que devuelve el fondo al color base. Es SVG/CSS puro:
 * no hay imagen externa, ni petición de red, ni JavaScript en el cliente.
 *
 * La luz usa `--um-brand`, así que en tema claro el halo es oscuro y en oscuro
 * es claro: el mismo componente sirve para ambos sin duplicar tokens.
 */
export function AuroraBackdrop({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
    >
      <svg
        viewBox="0 0 900 600"
        preserveAspectRatio="xMidYMid slice"
        focusable="false"
        className="absolute left-1/2 top-[-38%] h-[135%] w-[165%] -translate-x-1/2"
      >
        <defs>
          <radialGradient id="um-aurora-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--um-brand)" stopOpacity="0.16" />
            <stop offset="55%" stopColor="var(--um-brand)" stopOpacity="0.05" />
            <stop offset="100%" stopColor="var(--um-brand)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="um-aurora-edge" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--um-brand)" stopOpacity="0.08" />
            <stop offset="100%" stopColor="var(--um-brand)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="330" cy="250" rx="330" ry="235" fill="url(#um-aurora-core)" />
        <ellipse cx="700" cy="400" rx="260" ry="200" fill="url(#um-aurora-edge)" />
      </svg>

      {/* Retícula: da escala y hace que el vacío se lea intencional. */}
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(to right, var(--um-border) 1px, transparent 1px), linear-gradient(to bottom, var(--um-border) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
          maskImage: 'radial-gradient(ellipse 70% 60% at 50% 0%, black, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 0%, black, transparent 75%)',
        }}
      />

      {/* Cierre inferior: el contenido arranca sobre el color base, sin corte. */}
      <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-b from-transparent to-background" />
    </div>
  );
}
