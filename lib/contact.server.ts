/**
 * lib/contact.server.ts — guardar el mensaje y avisar por correo (solo servidor).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ORDEN DELIBERADO
 *
 *  1. Se GUARDA en `contact_messages` (durable).
 *  2. Recién después se intenta avisar por Resend.
 *
 *  Al revés se perderían mensajes cuando Resend no está configurado o falla —
 *  que es exactamente el estado actual del proyecto. El correo es opcional; el
 *  mensaje no.
 *
 *  Si no hay base configurada se intenta igual el correo. Si tampoco hay correo,
 *  la API responde un error claro (`contact_unavailable`) en vez de fingir que
 *  el mensaje se envió.
 *
 *  LOGS: nunca se registra el mensaje, el correo ni el teléfono. Solo un id
 *  interno y el resultado de la entrega.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Resend } from 'resend';
import { createSqlClient, type SqlClient } from './db-driver.server';
import { getDatabaseUrl } from './db';
import { getPrefixedEnv } from './env';
import { getNotificationSender, getResendApiKey } from './notifications.server';
import type { ContactMessage } from './contact';

export type ContactDelivery =
  /** Guardado en la base; el correo se envió. */
  | 'stored'
  /** Guardado en la base; el correo falló o no está configurado (el mensaje NO se pierde). */
  | 'stored_email_failed'
  /** Sin base; el mensaje salió por correo. */
  | 'email_sent'
  /** Ni base ni correo: no se pudo recibir el mensaje. */
  | 'unavailable';

export type ContactEmailStatus = 'sent' | 'failed' | 'not_configured';

const SEND_TIMEOUT_MS = 5_000;

let cachedSql: SqlClient | null = null;

function getContactSql(): SqlClient | null {
  const url = getDatabaseUrl();
  if (!url) return null;
  if (!cachedSql) cachedSql = createSqlClient(url);
  return cachedSql;
}

export function isContactStorageConfigured(): boolean {
  return !!getDatabaseUrl();
}

/** Destinatario de la bandeja. Sin configurar, el correo se omite (no falla). */
export function getContactRecipient(): string | null {
  const value = (getPrefixedEnv('CONTACT_TO_EMAIL') ?? '').trim();
  return value || null;
}

export function isContactEmailConfigured(): boolean {
  return getResendApiKey().length > 0 && getContactRecipient() !== null;
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

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('contact_email_timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Inserta el mensaje y devuelve su id. Lanza si la base falla (el llamador decide). */
export async function persistContactMessage(message: ContactMessage): Promise<string | null> {
  const sql = getContactSql();
  if (!sql) return null;

  const rows = await sql`
    INSERT INTO contact_messages (name, email, phone, message, source)
    VALUES (${message.name}, ${message.email}, ${message.phone}, ${message.message}, ${message.source})
    RETURNING id
  `;

  const id = rows[0]?.id;
  return typeof id === 'string' ? id : null;
}

async function updateEmailStatus(id: string, status: ContactEmailStatus): Promise<void> {
  const sql = getContactSql();
  if (!sql) return;
  try {
    await sql`UPDATE contact_messages SET email_status = ${status} WHERE id = ${id}::uuid`;
  } catch {
    // El mensaje ya está guardado: no poder anotar el estado no lo invalida.
  }
}

/**
 * Aviso al negocio. Devuelve un estado, NUNCA lanza: el mensaje ya está a salvo
 * en la base y un fallo de correo no debe convertirse en un error para el usuario.
 */
export async function sendContactNotification(message: ContactMessage): Promise<ContactEmailStatus> {
  const apiKey = getResendApiKey();
  const recipient = getContactRecipient();
  if (!apiKey || !recipient) return 'not_configured';

  try {
    const result = await withTimeout(
      getResendClient(apiKey).emails.send({
        from: getNotificationSender(),
        to: recipient,
        replyTo: message.email,
        subject: `Contacto web · ${message.name}`,
        text: [
          `Nombre: ${message.name}`,
          `Correo: ${message.email}`,
          `Teléfono: ${message.phone ?? '—'}`,
          '',
          message.message,
        ].join('\n'),
      }),
      SEND_TIMEOUT_MS,
    );

    if (result.error) {
      console.error('[contacto] Resend rechazó el aviso', { code: result.error.name });
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    console.error('[contacto] fallo al enviar el aviso', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return 'failed';
  }
}

export interface ContactSubmissionResult {
  delivery: ContactDelivery;
  id: string | null;
  emailStatus: ContactEmailStatus;
}

/** Orquesta guardar → avisar, con degradación segura. */
export async function submitContactMessage(message: ContactMessage): Promise<ContactSubmissionResult> {
  let id: string | null = null;

  try {
    id = await persistContactMessage(message);
  } catch (error) {
    console.error('[contacto] no se pudo guardar el mensaje', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }

  const emailStatus = await sendContactNotification(message);
  if (id) await updateEmailStatus(id, emailStatus);

  if (id) {
    return {
      delivery: emailStatus === 'sent' ? 'stored' : 'stored_email_failed',
      id,
      emailStatus,
    };
  }

  if (emailStatus === 'sent') {
    return { delivery: 'email_sent', id: null, emailStatus };
  }

  return { delivery: 'unavailable', id: null, emailStatus };
}
