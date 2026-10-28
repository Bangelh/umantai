/**
 * lib/email.server.ts — correo transaccional de autenticación.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  PROVIDERS
 *
 *  1. `resend`     — si `RESEND_API_KEY` existe. Es el provider real.
 *  2. `test`       — solo fuera de Producción y con `AUTH_TEST_MODE=1`. NO envía
 *                    nada: escribe el mensaje (con su enlace) en `email_outbox`.
 *                    El E2E lee de ahí para completar verificación / reset.
 *  3. `disabled`   — en Producción sin API key. El registro sigue funcionando
 *                    (la cuenta se crea), pero el envío falla cerrado y se
 *                    registra el evento; nunca se imprime el token.
 *
 *  Nunca se loguea el enlace ni el token: llevan credenciales de un solo uso.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Resend } from 'resend';

import { getPrefixedEnv } from './env';
import { getPlatformSql } from './platform-db.server';
import { isProductionRuntime } from './runtime-environment.server';

export type EmailPurpose = 'verify_email' | 'reset_password' | 'store_created';

export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  purpose: EmailPurpose;
  /** Enlace con token; se guarda solo en el outbox de test. */
  actionUrl: string;
  expiresInSeconds: number;
}

export type EmailDelivery =
  | { status: 'sent'; id?: string }
  | { status: 'stored'; id: string }
  | { status: 'disabled'; reason: string }
  | { status: 'failed'; reason: string };

export type EmailProviderName = 'resend' | 'test' | 'disabled';

const DEFAULT_SENDER = 'Umantai <onboarding@resend.dev>';
const SEND_TIMEOUT_MS = 8_000;

function readEnv(key: string): string {
  return (getPrefixedEnv(key) ?? '').trim();
}

export function getEmailSender(): string {
  return readEnv('RESEND_FROM_EMAIL') || DEFAULT_SENDER;
}

/** El modo test exige flag explícito Y un entorno que no sea Producción. */
export function isAuthTestMode(): boolean {
  return readEnv('AUTH_TEST_MODE') === '1' && !isProductionRuntime();
}

export function resolveEmailProviderName(): EmailProviderName {
  // Test mode GANA sobre una API key real: el E2E y el staging con clave no
  // deben enviar correos de verdad ni depender de un dominio verificado.
  if (isAuthTestMode()) return 'test';
  if (readEnv('RESEND_API_KEY')) return 'resend';
  return 'disabled';
}

let cachedClient: Resend | null = null;
let cachedKey: string | null = null;

function getResendClient(apiKey: string): Resend {
  if (!cachedClient || cachedKey !== apiKey) {
    cachedClient = new Resend(apiKey);
    cachedKey = apiKey;
  }
  return cachedClient;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('email_timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function storeInOutbox(email: TransactionalEmail): Promise<EmailDelivery> {
  const sql = getPlatformSql();
  if (!sql) return { status: 'failed', reason: 'db_not_configured' };

  try {
    const rows = await sql`
      INSERT INTO email_outbox (purpose, recipient, subject, body_text, action_url, expires_at)
      VALUES (
        ${email.purpose},
        ${email.to},
        ${email.subject},
        ${email.text},
        ${email.actionUrl},
        NOW() + (${email.expiresInSeconds} * INTERVAL '1 second')
      )
      RETURNING id
    `;
    return { status: 'stored', id: String(rows[0]?.id ?? '') };
  } catch (error) {
    // La migración 021 puede no estar aplicada todavía: no se rompe el signup.
    console.error('[email] no se pudo guardar en el outbox de test', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return { status: 'failed', reason: 'outbox_unavailable' };
  }
}

/**
 * Envía (o almacena en test-mode) un correo transaccional. Nunca lanza: el
 * llamador (Better Auth) no debe fallar el registro porque el correo esté caído.
 */
export async function sendTransactionalEmail(email: TransactionalEmail): Promise<EmailDelivery> {
  const provider = resolveEmailProviderName();

  if (provider === 'disabled') {
    console.warn(
      `[email] sin RESEND_API_KEY ni AUTH_TEST_MODE: no se pudo enviar "${email.purpose}".`,
    );
    return { status: 'disabled', reason: 'not_configured' };
  }

  if (provider === 'test') {
    return storeInOutbox(email);
  }

  const apiKey = readEnv('RESEND_API_KEY');
  try {
    const { data, error } = await withTimeout(
      getResendClient(apiKey).emails.send({
        from: getEmailSender(),
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        tags: [{ name: 'purpose', value: email.purpose }],
      }),
      SEND_TIMEOUT_MS,
    );

    if (error) {
      console.error('[email] Resend rechazó el envío', {
        purpose: email.purpose,
        message: error.message,
      });
      return { status: 'failed', reason: error.message };
    }
    return { status: 'sent', id: data?.id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    console.error('[email] falló el envío', { purpose: email.purpose, reason });
    return { status: 'failed', reason };
  }
}

// =============================================================================
//  PLANTILLAS (texto + HTML, sin imágenes ni recursos externos)
// =============================================================================

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, body: string, actionLabel: string, actionUrl: string): string {
  return `<!DOCTYPE html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;">
      <p style="margin:0;font-size:13px;letter-spacing:2px;color:#666666;">UMANTAI</p>
      <h1 style="margin:8px 0 12px;font-size:24px;color:#111111;">${escapeHtml(title)}</h1>
      ${body}
      <p style="margin:24px 0 0;">
        <a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;font-size:15px;">
          ${escapeHtml(actionLabel)}
        </a>
      </p>
      <p style="margin:20px 0 0;font-size:12px;color:#888888;border-top:1px solid #e4e4e7;padding-top:14px;">
        Si no solicitaste este correo, ignóralo. El enlace es de un solo uso.
      </p>
    </div>
  </body>
</html>`;
}

export function buildVerifyEmail(to: string, url: string, expiresInSeconds = 86_400): TransactionalEmail {
  const text = [
    'Verifica tu correo en UMANTAI',
    '',
    'Abre este enlace para confirmar tu cuenta:',
    url,
    '',
    'Si no creaste una cuenta, ignora este mensaje.',
  ].join('\n');

  return {
    to,
    subject: 'Verifica tu correo · UMANTAI',
    text,
    html: layout(
      'Verifica tu correo',
      '<p style="margin:0 0 8px;font-size:15px;color:#444444;">Confirma tu cuenta para asegurar la recuperación de contraseña y el historial de pedidos.</p>',
      'Verificar correo',
      url,
    ),
    purpose: 'verify_email',
    actionUrl: url,
    expiresInSeconds,
  };
}

/**
 * Aviso de "tu tienda quedó creada". No lleva token ni credenciales: solo
 * confirma el alta y dice cuál es el siguiente paso, para que el comerciante no
 * se quede con la duda de si el registro funcionó.
 */
export function buildStoreCreatedEmail(
  to: string,
  options: { storeName: string; slug: string; panelUrl: string; requiresVerification: boolean },
): TransactionalEmail {
  const { storeName, slug, panelUrl, requiresVerification } = options;

  const nextSteps = [
    '1. Entra a tu panel y carga tus primeros productos (nombre, precio y stock).',
    '2. Un administrador de UMANTAI revisa y activa la tienda.',
    `3. Cuando esté activa, tu vitrina pública será umantai.com/${slug}.`,
  ];
  if (requiresVerification) {
    nextSteps.unshift(
      '0. Verifica tu correo con el enlace que te enviamos al registrarte: sin eso no podrás recuperar tu contraseña.',
    );
  }

  const text = [
    `Tu tienda ${storeName} ya existe en UMANTAI`,
    '',
    'La creamos y quedó PENDIENTE DE APROBACIÓN: todavía no aparece en el buscador.',
    '',
    'Qué sigue:',
    ...nextSteps,
    '',
    `Abrir mi panel: ${panelUrl}`,
    '',
    'Si no creaste esta tienda, responde a este correo y la revisamos.',
  ].join('\n');

  return {
    to,
    subject: `Tu tienda ${storeName} ya existe · UMANTAI`,
    text,
    html: layout(
      `Tu tienda ${storeName} ya existe`,
      [
        '<p style="margin:0 0 12px;font-size:15px;color:#444444;">La creamos y quedó <strong>pendiente de aprobación</strong>: todavía no aparece en el buscador.</p>',
        '<p style="margin:0 0 6px;font-size:15px;color:#444444;">Qué sigue:</p>',
        `<ul style="margin:0 0 4px;padding-left:20px;font-size:15px;color:#444444;">${nextSteps
          .map((step) => `<li style="margin-bottom:4px">${escapeHtml(step.replace(/^\d+\.\s*/, ''))}</li>`)
          .join('')}</ul>`,
      ].join(''),
      'Abrir mi panel',
      panelUrl,
    ),
    purpose: 'store_created',
    actionUrl: panelUrl,
    // Sin token: el "vencimiento" solo controla cuánto vive la fila del outbox
    // de test. Una semana es suficiente para inspeccionarla.
    expiresInSeconds: 7 * 24 * 3_600,
  };
}

export function buildResetPasswordEmail(
  to: string,
  url: string,
  expiresInSeconds = 3_600,
): TransactionalEmail {
  const text = [
    'Restablece tu contraseña de UMANTAI',
    '',
    'Abre este enlace para elegir una contraseña nueva:',
    url,
    '',
    'El enlace vence en 1 hora. Si no lo pediste, ignora este mensaje.',
  ].join('\n');

  return {
    to,
    subject: 'Restablece tu contraseña · UMANTAI',
    text,
    html: layout(
      'Restablece tu contraseña',
      '<p style="margin:0 0 8px;font-size:15px;color:#444444;">Recibimos una solicitud para cambiar la contraseña de tu cuenta. El enlace vence en 1 hora.</p>',
      'Elegir contraseña nueva',
      url,
    ),
    purpose: 'reset_password',
    actionUrl: url,
    expiresInSeconds,
  };
}

// =============================================================================
//  LECTURA DEL OUTBOX (solo test-mode)
// =============================================================================

export interface OutboxMessage {
  id: string;
  purpose: string;
  recipient: string;
  subject: string;
  actionUrl: string | null;
  createdAt: string;
}

/**
 * Devuelve el último mensaje del outbox para un correo. Fail-closed: fuera de
 * test-mode devuelve `null` sin tocar la base.
 */
export async function readLatestOutboxMessage(
  recipient: string,
  purpose?: EmailPurpose,
): Promise<OutboxMessage | null> {
  if (!isAuthTestMode()) return null;
  const sql = getPlatformSql();
  if (!sql) return null;

  const normalized = recipient.trim().toLowerCase();
  const rows = purpose
    ? await sql`
        SELECT id, purpose, recipient, subject, action_url, created_at
          FROM email_outbox
         WHERE lower(recipient) = ${normalized}
           AND purpose = ${purpose}
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY created_at DESC
         LIMIT 1
      `
    : await sql`
        SELECT id, purpose, recipient, subject, action_url, created_at
          FROM email_outbox
         WHERE lower(recipient) = ${normalized}
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY created_at DESC
         LIMIT 1
      `;

  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    purpose: String(row.purpose),
    recipient: String(row.recipient),
    subject: String(row.subject),
    actionUrl: row.action_url ? String(row.action_url) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/** Borra mensajes vencidos; pensado para el cron de mantenimiento. */
export async function purgeExpiredOutbox(): Promise<number> {
  if (isProductionRuntime()) return 0;
  const sql = getPlatformSql();
  if (!sql) return 0;
  const rows = await sql`
    DELETE FROM email_outbox
     WHERE expires_at IS NOT NULL AND expires_at < NOW() - INTERVAL '1 day'
     RETURNING id
  `;
  return rows.length;
}
