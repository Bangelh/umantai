import { NextResponse } from 'next/server';
import { requireAdminToken } from '@/lib/admin.server';
import {
  getMpOrdersBackUrlBase,
  isMpOrdersConfigured,
  isMpOrdersWebhookConfigured,
} from '@/lib/mercadopago-orders.server';

/**
 * GET /api/mp-orders/debug — diagnóstico PREVIEW-ONLY de la integración clean-room.
 *
 * Responde SOLO booleanos y etiquetas: nunca valores de variables, ni prefijos de
 * tokens, ni longitudes, ni cookies, ni el secreto. El objetivo es comprobar que
 * Preview ve las tres variables NUEVAS (`MP_ORDERS_*`) y que NO toca las legacy.
 *
 * Candados (TODOS obligatorios; falla cerrado):
 *   1. `VERCEL_ENV === 'preview'` — Production y desarrollo local NUNCA lo habilitan.
 *   2. Token admin válido (`x-admin-token`) vía `requireAdminToken` (401/503).
 *
 * Es un endpoint de experimento: se puede ELIMINAR sin afectar nada más.
 *
 * Respuestas: 200 diagnóstico · 403 fuera de Preview · 401/503 auth admin.
 */

export async function GET(request: Request) {
  const vercelEnv = (process.env.VERCEL_ENV ?? '').trim();

  if (vercelEnv !== 'preview') {
    return NextResponse.json(
      {
        ok: false,
        code: 'debug_not_available',
        error: 'El diagnóstico de mp-orders solo está disponible en Preview.',
      },
      { status: 403 },
    );
  }

  const access = requireAdminToken(request);
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, code: access.code, error: access.message },
      { status: access.status },
    );
  }

  return NextResponse.json(
    {
      runtime: process.env.NEXT_RUNTIME ?? 'nodejs',
      vercelEnv,
      accessTokenConfigured: isMpOrdersConfigured(),
      webhookSecretConfigured: isMpOrdersWebhookConfigured(),
      backUrlConfigured: getMpOrdersBackUrlBase().length > 0,
      implementation: 'orders-cleanroom',
      // Estructuralmente falso: los módulos clean-room leen `process.env` de forma
      // explícita y solo consultan las variables `MP_ORDERS_*` (ver tests de
      // aislamiento: ningún archivo nuevo menciona el nombre de una variable legacy).
      legacyVariablesUsed: false,
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
