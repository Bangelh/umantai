'use client';

import { useState } from 'react';

/**
 * Puerta de entrada del terminal: la clave del dispositivo.
 *
 * Se pide UNA vez y se guarda sólo en memoria. No va a `localStorage` a propósito: la
 * tablet del kiosco vive en un local abierto al público, y una clave persistida ahí es
 * una clave que cualquiera puede extraer del navegador.
 *
 * La clave la verifica el SERVIDOR (`KIOSK_ACCESS_CODE`, ver `lib/kiosk.server.ts`): no
 * está en el bundle de la aplicación, así que no se puede leer desde las herramientas
 * de desarrollador. Es el candado mínimo e imprescindible antes de exponer un endpoint
 * que descuenta inventario y entrega mercadería.
 */

interface DeviceKeyGateProps {
  onSubmit: (accessKey: string) => void;
  isChecking: boolean;
  error: string | null;
}

export function DeviceKeyGate({ onSubmit, isChecking, error }: DeviceKeyGateProps) {
  const [value, setValue] = useState('');

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-6 py-10">
      <form
        className="w-full max-w-lg"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim() && !isChecking) onSubmit(value.trim());
        }}
      >
        <h1 className="text-4xl font-bold tracking-tight text-white">Kiosco Umantai</h1>
        <p className="mt-3 text-2xl leading-snug text-neutral-200">
          Escribe la clave del dispositivo para empezar.
        </p>

        <label className="mt-8 block text-2xl text-neutral-200">
          Clave del dispositivo
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoFocus
            autoComplete="off"
            disabled={isChecking}
            className="mt-2 h-24 w-full rounded-2xl border-2 border-white/30 bg-neutral-900 px-6 text-3xl tracking-widest text-white focus:border-sky-400 focus:outline-none"
          />
        </label>

        {error && (
          <p role="alert" className="mt-4 rounded-2xl border-2 border-red-400/60 bg-red-950/60 px-5 py-4 text-2xl text-red-100">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={isChecking || !value.trim()}
          className="mt-6 min-h-[96px] w-full select-none rounded-2xl border-2 border-white bg-white text-3xl font-bold text-neutral-950 touch-manipulation active:bg-white/80 disabled:opacity-50"
        >
          {isChecking ? 'Abriendo…' : 'ABRIR KIOSCO'}
        </button>

        <p className="mt-6 text-xl text-neutral-400">
          Si no la tienes, pídesela al supervisor. No es la contraseña de tu correo.
        </p>
      </form>
    </div>
  );
}

export default DeviceKeyGate;
