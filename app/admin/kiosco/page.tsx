'use client';

import { useCallback, useEffect, useState } from 'react';
import type { KioskOrderSummary } from '@/lib/commerce';
import { DeviceKeyGate } from './components/DeviceKeyGate';
import { PinEntryPanel } from './components/PinEntryPanel';
import { PickupResultOverlay, type PickupOutcome } from './components/PickupResultOverlay';
import { PreparationList } from './components/PreparationList';
import { ReadyOrdersList } from './components/ReadyOrdersList';

/**
 * /admin/kiosco — panel de la operaria del dark store.
 *
 * ─── DISEÑO PARA UNA OPERARIA DE 70 AÑOS ─────────────────────────────────────
 *  · Una sola pantalla, sin navegación. Nada de menús, breadcrumbs ni links: cada
 *    elemento de más es una decisión de más.
 *  · Tipografía mínima de 20 px (casi todo 24-48 px) y botones de 96 px de alto.
 *  · Todo lo accionable dice QUÉ HACE con palabras ("YA ESTÁ EN EL CASILLERO", no un
 *    ✅). Los íconos no se explican solos.
 *  · Los errores dicen qué pasó y qué hacer, en español de mostrador.
 *  · Un resultado se cierra a propósito con un botón gigante: nunca se autodescarta.
 *
 * ─── POR QUÉ NO ES UN SERVER COMPONENT ───────────────────────────────────────
 * La clave del dispositivo vive en memoria del navegador y toda la pantalla es
 * interactiva (teclado, tab, encuesta cada 10 s). Un server component obligaría a pasar
 * la clave al servidor en cada render, que es peor en todos los sentidos.
 *
 * ─── QUÉ NO HACE (a propósito) ───────────────────────────────────────────────
 * No muestra el PIN de ningún pedido: lo recibe dictado por el cliente y lo tipea. Acá
 * el PIN es el control de que quien retira es quien compró; si estuviera en pantalla,
 * no probaría nada.
 */

/** Cada cuánto se refresca la cola. La tablet queda fija, así que 10 s es barato. */
const POLL_INTERVAL_MS = 10_000;

/**
 * Id de este terminal, para correlacionar la auditoría en `pickup_attempts`.
 *
 * Es por pestaña (cambia al recargar): sirve para reconstruir "qué pasó en esta
 * sesión", no como identidad de dispositivo. El freno de intentos no depende de esto
 * —lo que de verdad lo detiene es la IP y el tope global—, y por eso no se persiste:
 * no hay ningún dato valioso que guardar en la tablet.
 */
const DEVICE_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `kiosco-${crypto.randomUUID().slice(0, 8)}`
    : 'kiosco';

type Tab = 'deliver' | 'prepare';

interface QueuePayload {
  ok?: boolean;
  ready?: KioskOrderSummary[];
  preparing?: KioskOrderSummary[];
  generatedAt?: string;
  error?: string;
}

/** Respuesta de `POST /api/kiosk/ready`. */
interface ReadyPayload {
  ok?: boolean;
  error?: string;
  /** `sent` | `failed` | `not_configured` | `order_not_found` (ver lib/notifications.server.ts). */
  adminNotification?: string;
}

/** Aviso posterior de "YA ESTÁ EN EL CASILLERO". */
interface ReadyNotice {
  ok: boolean;
  message: string;
  /** Línea aparte para lo que la operaria DEBE hacer aunque el pedido esté bien. */
  warning?: string;
}

/**
 * Traduce el resultado del aviso a algo que la operaria pueda accionar.
 *
 * `sent` no dice nada: que el correo haya salido bien no cambia lo que ella tiene que
 * hacer. Lo que sí importa es cuándo Omar NO se va a enterar, porque el cliente ya está
 * en el mostrador y ese aviso es lo único que le da tiempo a la tienda a prepararse.
 */
function notificationWarning(status: unknown): string | undefined {
  switch (status) {
    case 'failed':
    case 'order_not_found':
      return 'No se pudo enviar el aviso por correo a la tienda. Avisa a Omar que este pedido está listo.';
    case 'not_configured':
      return 'El aviso automático por correo no está configurado. Avisa a Omar que este pedido está listo.';
    default:
      return undefined;
  }
}

function kioskHeaders(accessKey: string, json = false): HeadersInit {
  return {
    'x-kiosk-access': accessKey,
    'x-kiosk-device': DEVICE_ID,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

function formatClock(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('es-PE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'America/Lima',
  }).format(date);
}

export default function KioscoPage() {
  const [accessKey, setAccessKey] = useState<string | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);

  const [tab, setTab] = useState<Tab>('deliver');
  const [queue, setQueue] = useState<{ ready: KioskOrderSummary[]; preparing: KioskOrderSummary[] }>({
    ready: [],
    preparing: [],
  });
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);

  const [pin, setPin] = useState('');
  const [isCheckingPin, setIsCheckingPin] = useState(false);
  const [outcome, setOutcome] = useState<PickupOutcome | null>(null);

  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [readyNotice, setReadyNotice] = useState<ReadyNotice | null>(null);

  const applyQueue = useCallback((payload: QueuePayload) => {
    setQueue({ ready: payload.ready ?? [], preparing: payload.preparing ?? [] });
    setLastUpdated(payload.generatedAt ?? new Date().toISOString());
    setIsStale(false);
  }, []);

  const loadQueue = useCallback(async () => {
    if (!accessKey) return;

    try {
      const response = await fetch('/api/kiosk/queue', {
        headers: kioskHeaders(accessKey),
        cache: 'no-store',
      });

      // La clave dejó de valer (rotada o cambiada): se vuelve a la puerta de entrada
      // en vez de dejar una pantalla que ya no puede hacer nada.
      if (response.status === 401) {
        setAccessKey(null);
        setUnlockError('La clave del dispositivo ya no es válida. Vuelve a escribirla.');
        return;
      }

      const payload = (await response.json().catch(() => null)) as QueuePayload | null;
      if (!response.ok || !payload?.ok) {
        setIsStale(true);
        return;
      }

      applyQueue(payload);
    } catch {
      // Se marca la lista como vieja y se sigue: la tablet puede estar sin red un
      // momento y la operaria igual necesita ver lo que tenía.
      setIsStale(true);
    }
  }, [accessKey, applyQueue]);

  /**
   * Sondeo de la cola.
   *
   * El efecto SÓLO se suscribe al temporizador; no llama a `loadQueue()` en su cuerpo.
   * Además de evitar renders en cascada (lo que rechaza el linter de React de este
   * repo), es correcto: la primera carga ya la hizo el desbloqueo, así que
   * `accessKey` no nulo implica una cola recién leída. Las otras actualizaciones
   * (marcar listo, cerrar el resultado) son explícitas, no dependen de este efecto.
   */
  useEffect(() => {
    if (!accessKey) return;

    const timer = setInterval(() => {
      void loadQueue();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [accessKey, loadQueue]);

  const unlock = useCallback(async (candidate: string) => {
    setIsUnlocking(true);
    setUnlockError(null);

    try {
      const response = await fetch('/api/kiosk/queue', {
        headers: kioskHeaders(candidate),
        cache: 'no-store',
      });
      const payload = (await response.json().catch(() => null)) as QueuePayload | null;

      if (!response.ok || !payload?.ok) {
        setUnlockError(payload?.error ?? 'No se pudo abrir el kiosco. Intenta otra vez.');
        return;
      }

      applyQueue(payload);
      setAccessKey(candidate);
    } catch {
      setUnlockError('No hay conexión con el servidor. Revisa la red de la tablet.');
    } finally {
      setIsUnlocking(false);
    }
  }, [applyQueue]);

  /**
   * Valida el PIN contra el servidor.
   *
   * Se llama SOLO cuando ya hay 6 dígitos: pedir un botón de "confirmar" agrega un paso
   * que se puede olvidar, y el sexto dígito ya es una confirmación inequívoca.
   */
  const submitPin = useCallback(
    async (code: string) => {
      if (!accessKey) return;

      setIsCheckingPin(true);
      setReadyNotice(null);

      try {
        const response = await fetch('/api/kiosk/pickup', {
          method: 'POST',
          headers: kioskHeaders(accessKey, true),
          body: JSON.stringify({ code }),
        });
        const payload = await response.json().catch(() => null);

        if (response.status === 401) {
          setAccessKey(null);
          setUnlockError('La clave del dispositivo ya no es válida. Vuelve a escribirla.');
          return;
        }

        if (payload?.ok) {
          // Se enriquece con lo que ya sabemos del pedido para que la pantalla de
          // éxito diga exactamente qué entregar y a quién.
          const known = queue.ready.find((order) => order.orderId === payload.orderId);

          setOutcome({
            ok: true,
            message: 'Entrega registrada. El stock ya se descontó.',
            orderNumber: payload.orderNumber ?? known?.orderNumber ?? null,
            lockerSlot: payload.lockerSlot ?? known?.lockerSlot ?? null,
            customerName: known?.customerName ?? null,
            itemSummary: known?.itemSummary ?? null,
          });
        } else {
          setOutcome({
            ok: false,
            message: payload?.error ?? 'No se pudo validar el PIN. Llama al supervisor.',
            orderNumber: null,
            lockerSlot: null,
            customerName: null,
            itemSummary: null,
          });
        }
      } catch {
        setOutcome({
          ok: false,
          message: 'No hubo respuesta del servidor. NO entregues el pedido todavía y reintenta.',
          orderNumber: null,
          lockerSlot: null,
          customerName: null,
          itemSummary: null,
        });
      } finally {
        setIsCheckingPin(false);
        setPin('');
      }
    },
    [accessKey, queue],
  );

  /**
   * Un dígito del teclado.
   *
   * El disparo de la validación se hace ACA y no dentro de un `setPin(updater)`:
   * los updaters de estado tienen que ser puros y React los puede llamar dos veces
   * (StrictMode en desarrollo). Un `fetch` adentro se enviaría dos veces, y el segundo
   * intento con el mismo PIN respondería `pickup_code_already_used` para un PIN
   * perfectamente válido — la operaria vería "NO ENTREGAR" sobre una entrega real.
   */
  const handleDigit = (digit: string) => {
    if (!accessKey || isCheckingPin || outcome) return;
    if (pin.length >= 6) return;

    const next = `${pin}${digit}`;
    setPin(next);
    if (next.length === 6) void submitPin(next);
  };

  const handleMarkReady = useCallback(
    async (orderId: string, lockerSlot: string | null) => {
      if (!accessKey) return;

      setBusyOrderId(orderId);
      setReadyNotice(null);

      try {
        const response = await fetch('/api/kiosk/ready', {
          method: 'POST',
          headers: kioskHeaders(accessKey, true),
          body: JSON.stringify({ orderId, lockerSlot }),
        });
        const payload = (await response.json().catch(() => null)) as ReadyPayload | null;

        if (response.status === 401) {
          setAccessKey(null);
          setUnlockError('La clave del dispositivo ya no es válida. Vuelve a escribirla.');
          return;
        }

        if (payload?.ok) {
          setReadyNotice({
            ok: true,
            message: `Pedido listo${lockerSlot ? ` en el casillero ${lockerSlot}` : ''}. Su PIN ya funciona.`,
            warning: notificationWarning(payload.adminNotification),
          });
          await loadQueue();
        } else {
          setReadyNotice({
            ok: false,
            message: payload?.error ?? 'No se pudo preparar el pedido.',
          });
        }
      } catch {
        setReadyNotice({ ok: false, message: 'No hubo respuesta del servidor. Reintenta.' });
      } finally {
        setBusyOrderId(null);
      }
    },
    [accessKey, loadQueue],
  );

  if (!accessKey) {
    return <DeviceKeyGate onSubmit={unlock} isChecking={isUnlocking} error={unlockError} />;
  }

  return (
    <div className="min-h-screen bg-neutral-950 pb-24">
      {/* Encabezado: estado del sistema, sin nada más */}
      <header className="border-b-2 border-white/15 bg-neutral-900 px-5 py-4">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-bold tracking-tight text-white">Kiosco Umantai</h1>
          <div className="flex items-center gap-4">
            <span className="text-xl text-neutral-300">Actualizado {formatClock(lastUpdated)}</span>
            <button
              type="button"
              onClick={() => {
                void loadQueue();
              }}
              className="min-h-[64px] select-none rounded-2xl border-2 border-white/40 px-5 text-2xl font-semibold text-white touch-manipulation active:bg-white/10"
            >
              Actualizar
            </button>
          </div>
        </div>
      </header>

      {/* Pestañas gigantes: sólo dos, y la activa se ve blanca entera */}
      <nav className="sticky top-0 z-10 border-b-2 border-white/15 bg-neutral-950 px-5 py-3">
        <div className="mx-auto flex max-w-3xl gap-3">
          {(
            [
              { id: 'deliver' as Tab, label: 'ENTREGAR', count: queue.ready.length },
              { id: 'prepare' as Tab, label: 'PREPARAR', count: queue.preparing.length },
            ]
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              aria-current={tab === item.id ? 'page' : undefined}
              className={
                'min-h-[88px] flex-1 select-none rounded-2xl border-2 text-3xl font-bold touch-manipulation ' +
                (tab === item.id
                  ? 'border-white bg-white text-neutral-950'
                  : 'border-white/30 bg-neutral-900 text-white')
              }
            >
              {item.label}
              <span className="ml-3 text-2xl">({item.count})</span>
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-3xl space-y-6 px-5 py-6">
        {tab === 'deliver' ? (
          <>
            <PinEntryPanel
              pin={pin}
              isChecking={isCheckingPin}
              disabled={Boolean(outcome)}
              onDigit={handleDigit}
              onBackspace={() => setPin((current) => current.slice(0, -1))}
              onClear={() => setPin('')}
            />
            <ReadyOrdersList orders={queue.ready} isStale={isStale} />
          </>
        ) : (
          <>
            {readyNotice && (
              <div
                role="status"
                className={
                  'rounded-2xl border-2 px-5 py-4 ' +
                  (readyNotice.ok
                    ? 'border-emerald-400/60 bg-emerald-950/60 text-emerald-100'
                    : 'border-red-400/60 bg-red-950/60 text-red-100')
                }
              >
                <p className="text-2xl">{readyNotice.message}</p>
                {readyNotice.warning && (
                  <p className="mt-3 border-t-2 border-amber-400/50 pt-3 text-2xl font-semibold text-amber-100">
                    ⚠ {readyNotice.warning}
                  </p>
                )}
              </div>
            )}
            <PreparationList
              orders={queue.preparing}
              busyOrderId={busyOrderId}
              onMarkReady={handleMarkReady}
            />
          </>
        )}
      </main>

      <footer className="px-5">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <span className="text-lg text-neutral-500">Terminal {DEVICE_ID}</span>
          <button
            type="button"
            onClick={() => {
              setAccessKey(null);
              setPin('');
              setOutcome(null);
            }}
            className="min-h-[56px] select-none rounded-xl border border-white/25 px-4 text-xl text-neutral-300 touch-manipulation active:bg-white/10"
          >
            Bloquear dispositivo
          </button>
        </div>
      </footer>

      {outcome && (
        <PickupResultOverlay
          outcome={outcome}
          onClose={() => {
            setOutcome(null);
            // El pedido entregado ya no está listo: se refresca para que la lista de
            // atrás diga la verdad apenas se cierra el aviso.
            void loadQueue();
          }}
        />
      )}
    </div>
  );
}
