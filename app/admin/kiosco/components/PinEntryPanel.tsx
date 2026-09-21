'use client';

import { KioskPinPad } from './KioskPinPad';

/**
 * Panel de ingreso del PIN: los 6 casilleros + el teclado.
 *
 * Los dígitos se muestran TAL CUAL, no como puntos.
 *
 * Suena contraintuitivo en un PIN, pero acá es lo correcto: el cliente está dictando
 * el código en voz alta a 50 cm de distancia, así que ocultarlo no protege nada, y en
 * cambio la operaria pierde la única forma de verificar que tipeó bien antes de que el
 * sexto dígito dispare la validación. En un mostrador, el error humano cuesta más que
 * la mirada de nadie.
 */

interface PinEntryPanelProps {
  pin: string;
  isChecking: boolean;
  /** Se apaga mientras hay un resultado en pantalla, para no encolar validaciones. */
  disabled?: boolean;
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onClear: () => void;
}

const PIN_LENGTH = 6;

export function PinEntryPanel({
  pin,
  isChecking,
  disabled = false,
  onDigit,
  onBackspace,
  onClear,
}: PinEntryPanelProps) {
  const slots = Array.from({ length: PIN_LENGTH }, (_, index) => pin[index] ?? null);
  const missing = PIN_LENGTH - pin.length;

  return (
    <section aria-label="Ingreso del PIN del cliente" className="rounded-3xl border-2 border-white/15 bg-neutral-900 p-6">
      <h2 className="text-3xl font-semibold text-white">PIN del cliente</h2>
      <p className="mt-2 text-2xl leading-snug text-neutral-200">
        Pídele al cliente los <span className="font-semibold text-white">6 números</span> de su pedido y
        escríbelos acá.
      </p>

      {/* Casilleros */}
      <div className="mt-6 flex justify-center gap-2" aria-hidden="true">
        {slots.map((digit, index) => (
          <div
            key={index}
            className={
              'flex h-24 w-14 items-center justify-center rounded-2xl border-2 text-5xl font-semibold ' +
              (digit
                ? 'border-white bg-white text-neutral-950'
                : index === pin.length
                  ? 'animate-pulse border-sky-400 bg-neutral-950 text-neutral-500'
                  : 'border-white/25 bg-neutral-950 text-neutral-600')
            }
          >
            {digit ?? '·'}
          </div>
        ))}
      </div>

      {/* Estado, en texto grande y en palabras */}
      <p
        className="mt-4 min-h-[2.5rem] text-center text-2xl text-neutral-200"
        aria-live="polite"
        role="status"
      >
        {isChecking ? (
          <span className="font-semibold text-sky-300">Validando…</span>
        ) : missing === PIN_LENGTH ? (
          'Esperando el primer número'
        ) : missing > 0 ? (
          <>
            Faltan <span className="font-semibold text-white">{missing}</span>{' '}
            {missing === 1 ? 'número' : 'números'}
          </>
        ) : (
          'Completo'
        )}
      </p>

      <div className="mt-4">
        <KioskPinPad
          onDigit={onDigit}
          onBackspace={onBackspace}
          onClear={onClear}
          disabled={disabled || isChecking}
        />
      </div>
    </section>
  );
}

export default PinEntryPanel;
