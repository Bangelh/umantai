/**
 * lib/kiosk.server.ts — acceso del terminal de kiosco (panel de la operaria).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTE ESTE ARCHIVO
 *
 *  El panel `/admin` y sus rutas ya están cerradas con `ADMIN_API_SECRET` y el
 *  header `x-admin-token` (ver `lib/admin.server.ts`), y el kiosco usa SU PROPIA
 *  clave. Son llaves distintas a propósito: quien puede editar precios no debería
 *  poder, con esa misma credencial, entregar mercadería.
 *
 *  El kiosco valida PIN y CONSOLIDA INVENTARIO (entrega mercadería). Un endpoint
 *  abierto ahí es una tienda con la puerta sin llave y la caja abierta.
 *
 *  Solución de este bloque: una clave de dispositivo verificada en el SERVIDOR
 *  (`KIOSK_ACCESS_CODE`), que el navegador nunca ve en el bundle porque se teclea en
 *  pantalla y viaja por header. No es autenticación de usuario — es el candado mínimo
 *  que hace falta antes de exponer un endpoint que mueve stock.
 *
 *  LO QUE NO RESUELVE: la clave es compartida, así que no identifica a la persona
 *  (para eso hace falta Supabase Auth con roles, que es el siguiente bloque).
 *  Y si falta la variable, el kiosco queda CERRADO, no abierto: falla cerrado.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getPrefixedEnv } from './env';

/** Header donde viaja la clave de dispositivo. */
export const KIOSK_ACCESS_HEADER = 'x-kiosk-access';

/** Header opcional con el nombre del terminal (`locker-front-01`), sólo para auditoría. */
export const KIOSK_DEVICE_HEADER = 'x-kiosk-device';

/** Mínimo exigido a la clave: menos que esto se rompe por fuerza bruta. */
const MIN_ACCESS_CODE_LENGTH = 10;

export function getKioskAccessCode(): string {
  return (getPrefixedEnv('KIOSK_ACCESS_CODE') ?? '').trim();
}

/** ¿Está configurado el kiosco? Si no, las rutas responden 503 en vez de abrirse. */
export function isKioskConfigured(): boolean {
  return getKioskAccessCode().length > 0;
}

/** Se avisa en logs (una sola vez por proceso) si la clave es demasiado corta. */
let warnedAboutShortCode = false;

function warnIfWeakCode(code: string): void {
  if (warnedAboutShortCode) return;
  if (code.length >= MIN_ACCESS_CODE_LENGTH) return;
  warnedAboutShortCode = true;
  console.warn(
    `⚠️  KIOSK_ACCESS_CODE tiene ${code.length} caracteres. Usa al menos ${MIN_ACCESS_CODE_LENGTH} ` +
      '(el kiosco valida PIN y descuenta inventario).',
  );
}

/**
 * Comparación de longitud constante.
 *
 * La longitud sí se filtra (corta en el primer `if`); lo que no se filtra es el
 * contenido, que es lo que permitiría reconstruir la clave byte a byte midiendo
 * tiempos de respuesta.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function verifyKioskAccessCode(provided: string | null | undefined): boolean {
  const expected = getKioskAccessCode();
  // Sin clave configurada, NADA pasa. Nunca "si no hay clave, dejo pasar".
  if (!expected) return false;
  if (typeof provided !== 'string') return false;
  const candidate = provided.trim();
  if (!candidate) return false;
  warnIfWeakCode(expected);
  return constantTimeEquals(candidate, expected);
}

/**
 * IP del cliente, para el freno de intentos.
 *
 * Es sólo un dato de limitación, no una identidad: `x-forwarded-for` lo puede
 * falsificar quien controla el cliente. En Cloudflare `cf-connecting-ip` lo escribe
 * el borde y es el que más se acerca a la verdad, por eso va primero.
 */
export function readClientIp(request: Request): string | null {
  const direct = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-real-ip');
  if (direct && direct.trim()) return direct.trim();

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  return null;
}

export type KioskAccessCheck =
  | {
      ok: true;
      /** Nombre del terminal declarado por el cliente (auditoría). */
      deviceId: string | null;
      ip: string | null;
      /** `'kiosk:<deviceId>'` o `'kiosk'` — lo que se firma en la auditoría. */
      actor: string;
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
    };

/**
 * Portero único de las rutas del kiosco.
 *
 * Devuelve datos, no una `NextResponse`, para no acoplar la librería a Next: cada
 * ruta traduce `ok: false` a su respuesta HTTP en dos líneas.
 */
export function checkKioskAccess(request: Request): KioskAccessCheck {
  if (!isKioskConfigured()) {
    return {
      ok: false,
      status: 503,
      code: 'kiosk_not_configured',
      message:
        'El kiosco no está configurado: falta KIOSK_ACCESS_CODE en el entorno del servidor.',
    };
  }

  if (!verifyKioskAccessCode(request.headers.get(KIOSK_ACCESS_HEADER))) {
    return {
      ok: false,
      status: 401,
      code: 'kiosk_unauthorized',
      message: 'Clave de dispositivo incorrecta.',
    };
  }

  const rawDevice = request.headers.get(KIOSK_DEVICE_HEADER);
  const deviceId = rawDevice && rawDevice.trim() ? rawDevice.trim().slice(0, 64) : null;

  return {
    ok: true,
    deviceId,
    ip: readClientIp(request),
    actor: deviceId ? `kiosk:${deviceId}` : 'kiosk',
  };
}

// =============================================================================
//  COPY PARA LA OPERARIA
//
//  En español y sin jerga técnica a propósito: quien lee esto es una operaria de
//  70 años con el cliente delante, no un desarrollador. Cada mensaje dice QUÉ PASÓ
//  y QUÉ HACER, en ese orden. El resto del sitio sigue en inglés; esta pantalla no.
// =============================================================================

/** Motivos por los que un PIN no sirve. La clave es el `error_code` del motor. */
export const PICKUP_FAILURE_COPY: Record<string, string> = {
  pickup_code_not_found:
    'Ese PIN no corresponde a ningún pedido. Pídele al cliente que te lo dicte otra vez.',
  pickup_code_expired:
    'Ese PIN ya venció. Dile al cliente que pida uno nuevo desde su pedido.',
  pickup_code_locked:
    'Este PIN se bloqueó por demasiados intentos fallidos. Hay que emitir uno nuevo.',
  pickup_code_already_used:
    '⚠ ATENCIÓN: este pedido YA se entregó antes. NO entregues nada y llama al supervisor.',
  pickup_rate_limited:
    'Demasiados intentos seguidos. Espera 2 minutos y vuelve a intentar.',
  order_requires_review:
    '⚠ ATENCIÓN: este pedido tiene un problema de stock/pago pendiente de revisión. NO entregues nada y llama al supervisor.',
};

/** Motivos por los que un pedido no se puede marcar como listo. */
export const READY_FAILURE_COPY: Record<string, string> = {
  invalid_order_transition:
    'Ese pedido ya no se puede preparar (puede que ya esté listo o cancelado). Actualiza la pantalla.',
  order_not_paid: 'Este pedido todavía NO está pagado. No se puede preparar mercadería sin cobrar.',
  order_requires_review:
    '⚠ ATENCIÓN: este pedido tiene un problema de stock/pago pendiente de revisión. NO lo prepares y llama al supervisor.',
  order_not_found: 'No encontramos ese pedido. Actualiza la pantalla y vuelve a intentar.',
};

/**
 * Enmascara un PIN para los logs.
 *
 * En la base queda completo (es la auditoría del intento, y sirve para ver un ataque
 * dirigido); en los logs sólo la mitad: los logs viajan a servicios de terceros y ahí
 * un PIN correcto no tiene por qué estar en texto plano.
 */
export function maskPickupCode(code: string): string {
  if (code.length <= 2) return '**';
  return `${code.slice(0, 2)}${'*'.repeat(code.length - 2)}`;
}
