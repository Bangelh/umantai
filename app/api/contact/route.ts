import { NextResponse } from 'next/server';
import { validateContactPayload } from '@/lib/contact';
import { submitContactMessage } from '@/lib/contact.server';
import { rateLimitGate } from '@/lib/rate-limit-http.server';
import { consumeRateLimit, rateLimitKeyFor } from '@/lib/rate-limit.server';

/**
 * POST /api/contact — formulario público de contacto.
 *
 * Protecciones:
 *   · validación server-side (`lib/contact.ts`), nunca se confía en el HTML;
 *   · honeypot `company` (los bots que lo rellenan reciben un ok inofensivo);
 *   · consentimiento explícito de privacidad;
 *   · rate limit por IP (5 envíos / 10 min);
 *   · tope de tamaño del cuerpo (16 KB).
 *
 * Respuestas:
 *   200 { ok: true, delivery }                      mensaje aceptado
 *   400 { ok: false, code: 'invalid_contact', errors }
 *   413 payload demasiado grande
 *   429 { ok: false, code: 'rate_limited' }
 *   503 { ok: false, code: 'contact_unavailable' }  no hay canal de recepción
 *
 * Privacidad: no se registran el mensaje, el correo ni el teléfono en logs.
 */
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16_000;

const DELIVERY_MESSAGE: Record<string, string> = {
  stored: 'Recibimos tu mensaje. Te responderemos al correo que indicaste.',
  stored_email_failed:
    'Recibimos tu mensaje y quedó registrado. El aviso automático no salió, pero lo revisaremos igual.',
  email_sent: 'Recibimos tu mensaje. Te responderemos al correo que indicaste.',
  ignored: 'Recibimos tu mensaje.',
};

export async function POST(request: Request) {
  const gate = await rateLimitGate(request, 'contact', { limit: 5, windowMs: 10 * 60_000 });
  if (gate) return gate;

  const limit = consumeRateLimit(rateLimitKeyFor(request, 'contact'), 5, 10 * 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        code: 'rate_limited',
        error: 'Recibimos varios mensajes seguidos. Espera unos minutos antes de reintentar.',
      },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, code: 'payload_too_large', error: 'El mensaje es demasiado largo.' },
      { status: 413 },
    );
  }

  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json(
        { ok: false, code: 'payload_too_large', error: 'El mensaje es demasiado largo.' },
        { status: 413 },
      );
    }
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { ok: false, code: 'invalid_body', error: 'No pudimos leer el formulario.' },
      { status: 400 },
    );
  }

  const validation = validateContactPayload(raw);
  if (!validation.ok) {
    // Honeypot: respuesta neutra para no enseñarle al bot qué campo lo delató.
    if (validation.spam) {
      return NextResponse.json(
        { ok: true, delivery: 'ignored', message: DELIVERY_MESSAGE.ignored },
        { status: 200 },
      );
    }
    return NextResponse.json(
      { ok: false, code: 'invalid_contact', errors: validation.errors },
      { status: 400 },
    );
  }

  try {
    const result = await submitContactMessage(validation.value);

    if (result.delivery === 'unavailable') {
      console.error('[contacto] sin canal de recepción configurado (ni base ni correo)');
      return NextResponse.json(
        {
          ok: false,
          code: 'contact_unavailable',
          error:
            'El canal de contacto no está disponible en este momento. Escríbenos por WhatsApp mientras lo solucionamos.',
        },
        { status: 503 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        delivery: result.delivery,
        message: DELIVERY_MESSAGE[result.delivery] ?? DELIVERY_MESSAGE.stored,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[contacto] error inesperado', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return NextResponse.json(
      {
        ok: false,
        code: 'contact_error',
        error: 'No pudimos enviar tu mensaje. Reintenta en un momento.',
      },
      { status: 500 },
    );
  }
}
