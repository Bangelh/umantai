'use client';

/**
 * Teclado numérico grande, tipo cajero automático.
 *
 * Decisiones de accesibilidad (la usuaria es una operaria de 70 años, de pie, con
 * el cliente delante y probablemente con luz de tienda reflejada en la pantalla):
 *
 *  · Teclas de 96 px de alto como mínimo y ancho completo de su celda. El dedo
 *    promedio acierta cómodamente; un teclado chico es la causa número uno de PINs
 *    mal tipeados, y cada error consume un intento del freno.
 *  · Orden 1-9-0 (el de todo teléfono y cajero) con el 0 abajo al centro.
 *  · Las teclas de acción dicen QUÉ HACEN, en palabras: "Borrar" y "Limpiar", nunca
 *    sólo un icono o una flecha. Un ⌫ no comunica nada si nunca usaste uno.
 *  · Contraste máximo: texto blanco puro sobre gris muy oscuro, borde marcado. Nada
 *    de grises medios para algo que hay que tocar.
 *  · `select-none` + `touch-manipulation`: sin selección de texto accidental ni
 *    retraso por doble toque en tablets.
 */

interface KioskPinPadProps {
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  /** Se bloquea mientras el servidor valida: evita el doble envío por doble toque. */
  disabled?: boolean;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function KioskPinPad({ onDigit, onBackspace, onClear, disabled = false }: KioskPinPadProps) {
  const keyClass =
    'flex h-24 select-none items-center justify-center rounded-2xl border-2 border-white/25 bg-neutral-800 ' +
    'text-5xl font-semibold text-white transition-colors touch-manipulation ' +
    'active:bg-neutral-600 disabled:opacity-40 disabled:active:bg-neutral-800';

  return (
    <div className="grid grid-cols-3 gap-3" role="group" aria-label="Teclado numérico">
      {DIGITS.map((digit) => (
        <button
          key={digit}
          type="button"
          disabled={disabled}
          onClick={() => onDigit(digit)}
          aria-label={`Número ${digit}`}
          className={keyClass}
        >
          {digit}
        </button>
      ))}

      {/* Fila inferior: las acciones flanquean al 0, igual que en un cajero. */}
      <button
        type="button"
        disabled={disabled}
        onClick={onBackspace}
        aria-label="Borrar el último número"
        className="flex h-24 select-none items-center justify-center rounded-2xl border-2 border-amber-400/60 bg-amber-950/40 text-2xl font-semibold text-amber-100 touch-manipulation active:bg-amber-900/60 disabled:opacity-40"
      >
        Borrar
      </button>

      <button
        type="button"
        disabled={disabled}
        onClick={() => onDigit('0')}
        aria-label="Número 0"
        className={keyClass}
      >
        0
      </button>

      <button
        type="button"
        disabled={disabled}
        onClick={onClear}
        aria-label="Borrar todos los números"
        className="flex h-24 select-none items-center justify-center rounded-2xl border-2 border-red-400/60 bg-red-950/40 text-2xl font-semibold text-red-100 touch-manipulation active:bg-red-900/60 disabled:opacity-40"
      >
        Limpiar
      </button>
    </div>
  );
}

export default KioskPinPad;
