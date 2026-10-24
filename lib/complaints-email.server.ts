/**
 * lib/complaints-email.server.ts — constancia y respuesta por correo.
 *
 * PREPARADO, NO ACTIVO: usa el mismo `RESEND_API_KEY` / `RESEND_FROM_EMAIL` que
 * el resto de notificaciones. Sin API key devuelve `not_configured` y NO lanza:
 * el reclamo ya quedó registrado y la constancia se muestra en pantalla.
 *
 * Reglas:
 *   · texto plano (sin HTML): no hay superficie de XSS en el correo;
 *   · nunca se registran DNI, teléfono, correo ni el contenido en logs;
 *   · timeout corto: un proveedor lento no puede colgar la respuesta al
 *     consumidor.
 */

import { Resend } from 'resend';

import { businessConfig } from '@/config/business';
import type { ComplaintKind } from './complaints';
import { getNotificationSender, getResendApiKey } from './notifications.server';

export type ComplaintEmailStatus = 'sent' | 'failed' | 'not_configured';

const SEND_TIMEOUT_MS = 5_000;

let cachedClient: Resend | null = null;
let cachedKey: string | null = null;

function getClient(apiKey: string): Resend {
  if (!cachedClient || cachedKey !== apiKey) {
    cachedClient = new Resend(apiKey);
    cachedKey = apiKey;
  }
  return cachedClient;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('complaint_email_timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function trackingUrl(publicCode: string): string {
  return `${businessConfig.siteUrl}/libro-de-reclamaciones/seguimiento/${encodeURIComponent(publicCode)}`;
}

function formatDueDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'long',
    timeZone: 'America/Lima',
  }).format(date);
}

function kindLabel(kind: ComplaintKind): string {
  return kind === 'queja' ? 'queja' : 'reclamo';
}

async function send(to: string, subject: string, text: string): Promise<ComplaintEmailStatus> {
  const apiKey = getResendApiKey();
  if (!apiKey || !to.trim()) return 'not_configured';

  try {
    const result = await withTimeout(
      getClient(apiKey).emails.send({
        from: getNotificationSender(),
        to,
        subject,
        text,
      }),
      SEND_TIMEOUT_MS,
    );
    if (result.error) {
      console.error('[reclamaciones] Resend rechazó el envío', { code: result.error.name });
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    console.error('[reclamaciones] fallo al enviar correo', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return 'failed';
  }
}

export interface ComplaintReceiptEmail {
  complaintNumber: string;
  publicCode: string;
  dueAt: string;
  kind: ComplaintKind;
  consumerEmail: string;
  consumerName: string;
}

/** Copia de la hoja de reclamación para el consumidor. */
export async function sendComplaintReceipt(input: ComplaintReceiptEmail): Promise<ComplaintEmailStatus> {
  const subject = `Constancia de ${kindLabel(input.kind)} ${input.complaintNumber} · ${businessConfig.name}`;
  const text = [
    `Hola ${input.consumerName},`,
    '',
    `Registramos tu ${kindLabel(input.kind)} con número ${input.complaintNumber}.`,
    `Fecha límite de respuesta: ${formatDueDate(input.dueAt)} (15 días hábiles).`,
    '',
    'Puedes consultar el estado y descargar o imprimir esta constancia en:',
    trackingUrl(input.publicCode),
    '',
    'Conserva este enlace y tu código de seguimiento. No compartas el enlace si no quieres que otra persona vea tu caso.',
    '',
    `— ${businessConfig.name}`,
  ].join('\n');

  return send(input.consumerEmail, subject, text);
}

export interface ComplaintResponseEmail {
  complaintNumber: string;
  publicCode: string;
  kind: ComplaintKind;
  consumerEmail: string;
  consumerName: string;
  dueAt: string;
  responseText: string;
}

/** Copia de la respuesta del proveedor. */
export async function sendComplaintResponse(
  input: ComplaintResponseEmail,
): Promise<ComplaintEmailStatus> {
  const subject = `Respuesta a tu ${kindLabel(input.kind)} ${input.complaintNumber} · ${businessConfig.name}`;
  const text = [
    `Hola ${input.consumerName},`,
    '',
    `Registramos la respuesta a tu ${kindLabel(input.kind)} ${input.complaintNumber}.`,
    `La fecha límite de respuesta era ${formatDueDate(input.dueAt)}.`,
    '',
    input.responseText,
    '',
    'Puedes ver la respuesta y la constancia completa en:',
    trackingUrl(input.publicCode),
    '',
    `— ${businessConfig.name}`,
  ].join('\n');

  return send(input.consumerEmail, subject, text);
}
