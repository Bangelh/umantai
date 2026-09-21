import { NextRequest, NextResponse } from 'next/server';
import { getKioskQueue, isCommerceDbConfigured } from '@/lib/commerce.server';
import { checkKioskAccess } from '@/lib/kiosk.server';

/**
 * GET /api/kiosk/queue — todo lo que necesita la pantalla de la operaria.
 *
 * Responde: `{ ok: true, ready: [...], preparing: [...], generatedAt }`
 *
 * `ready`     → pedidos con PIN vigente, listos para entregar (acá se usa el teclado).
 * `preparing` → pagados y sin preparar; la operaria los marca listos para que se emita
 *               su PIN.
 *
 * Los pedidos NO traen el PIN. La operaria lo recibe dictado por el cliente: si
 * estuviera en la misma pantalla donde se tipea, el control no probaría nada.
 *
 * 401 clave de dispositivo incorrecta · 503 sin base de datos o sin KIOSK_ACCESS_CODE
 */
export async function GET(request: NextRequest) {
  const access = checkKioskAccess(request);
  if (!access.ok) {
    return NextResponse.json({ ok: false, code: access.code, error: access.message }, { status: access.status });
  }

  if (!isCommerceDbConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        code: 'database_not_configured',
        error: 'La base de datos no está configurada en este entorno.',
      },
      { status: 503 },
    );
  }

  try {
    const queue = await getKioskQueue();

    return NextResponse.json(
      {
        ok: true,
        ready: queue.ready,
        preparing: queue.preparing,
        // La pantalla muestra "actualizado hace X" para que la operaria sepa si lo
        // que ve es viejo (una tablet que perdió la red no dice nada por sí sola).
        generatedAt: new Date().toISOString(),
      },
      {
        status: 200,
        // La cola cambia con cada entrega: que ningún intermediario la cachee.
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  } catch (error) {
    console.error('[kiosk] no se pudo leer la cola', error);
    return NextResponse.json(
      { ok: false, code: 'queue_unavailable', error: 'No se pudo cargar la lista de pedidos.' },
      { status: 500 },
    );
  }
}
