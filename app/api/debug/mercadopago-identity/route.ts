import { NextRequest, NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import { getMercadoPagoAccessToken } from '@/lib/mercadopago.server';
import {
  collectMercadoPagoIdentity,
  normalizeResourceId,
} from '@/lib/mercadopago-identity.server';

/**
 * GET /api/debug/mercadopago-identity — identidad de Mercado Pago (diagnóstico).
 *
 * Solo ADMIN (header `x-admin-token`). Sirve para comprobar si el
 * `MERCADOPAGO_ACCESS_TOKEN` del servidor pertenece a la MISMA aplicación cuyo
 * `MERCADOPAGO_WEBHOOK_SECRET` usamos para validar la firma del webhook.
 *
 * READ-ONLY: usa el token del servidor para consultar únicamente
 *   · GET /users/me
 *   · GET /checkout/preferences/{id}   (si `preferenceId`)
 *   · GET /v1/payments/{id}            (si `paymentId`)
 * y devuelve SOLO identificadores/metadatos no sensibles. NUNCA el token, el
 * webhook secret, cabeceras de autorización, el body crudo de MP ni datos
 * personales del comprador.
 *
 * Query params (ambos opcionales):
 *   · `preferenceId` — id de Preference de Checkout Pro.
 *   · `paymentId`    — id de pago.
 *
 * Respuestas: 200 diagnóstico (cada sección trae su `status` de MP) · 400 id
 * inválido · 401/503 auth admin · 503 sin MERCADOPAGO_ACCESS_TOKEN · 500.
 */

export async function GET(request: NextRequest) {
  const access = requireAdminToken(request);
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, code: access.code, error: access.message },
      { status: access.status },
    );
  }

  const accessToken = getMercadoPagoAccessToken();
  if (!accessToken) {
    return NextResponse.json(
      {
        ok: false,
        code: 'mercadopago_not_configured',
        error:
          'Mercado Pago no está configurado: falta MERCADOPAGO_ACCESS_TOKEN en el entorno del servidor.',
      },
      { status: 503 },
    );
  }

  const rawPreferenceId = request.nextUrl.searchParams.get('preferenceId');
  const rawPaymentId = request.nextUrl.searchParams.get('paymentId');

  const preferenceId = rawPreferenceId === null ? null : normalizeResourceId(rawPreferenceId);
  const paymentId = rawPaymentId === null ? null : normalizeResourceId(rawPaymentId);

  if ((rawPreferenceId !== null && !preferenceId) || (rawPaymentId !== null && !paymentId)) {
    return NextResponse.json(
      {
        ok: false,
        code: 'invalid_resource_id',
        error: 'preferenceId/paymentId deben ser identificadores alfanuméricos válidos.',
      },
      { status: 400 },
    );
  }

  try {
    const report = await collectMercadoPagoIdentity({ preferenceId, paymentId }, { accessToken });
    return NextResponse.json(
      { ok: true, ...report },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    // Defensa en profundidad: el orquestador ya traga los errores por sección; si
    // algo inesperado escapara, no se filtra ningún detalle.
    console.error('[debug/mercadopago-identity] fallo inesperado', error);
    return NextResponse.json(
      { ok: false, code: 'identity_unavailable', error: 'No se pudo obtener la identidad de Mercado Pago.' },
      { status: 500 },
    );
  }
}
