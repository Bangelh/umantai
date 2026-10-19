/**
 * lib/contact.ts — validación del formulario de contacto (pura).
 *
 * El navegador valida para dar feedback rápido; ESTO es la validación que
 * decide. Se ejecuta en el servidor, no confía en el HTML y normaliza antes de
 * guardar.
 *
 * Honeypot: el campo `company` está oculto para personas y visible para bots.
 * Si llega con contenido, se descarta en silencio (la API responde ok para no
 * darle al bot una señal de que fue detectado).
 */

export const CONTACT_LIMITS = {
  nameMin: 2,
  nameMax: 80,
  emailMax: 254,
  phoneMax: 30,
  messageMin: 10,
  messageMax: 2000,
} as const;

export interface ContactMessage {
  name: string;
  email: string;
  phone: string | null;
  message: string;
  source: string;
}

export type ContactValidation =
  | { ok: true; value: ContactMessage }
  | { ok: false; errors: Partial<Record<'name' | 'email' | 'phone' | 'message' | 'consent', string>>; spam?: boolean };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Colapsa espacios repetidos pero conserva los saltos de línea del mensaje. */
function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function normalizeMessage(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function validateContactPayload(raw: unknown): ContactValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: { message: 'El cuerpo del formulario no es válido.' } };
  }

  const body = raw as Record<string, unknown>;

  // Honeypot: no se valida nada más; el bot no debe saber qué falló.
  if (asString(body.company).trim().length > 0) {
    return { ok: false, errors: {}, spam: true };
  }

  const errors: Partial<Record<'name' | 'email' | 'phone' | 'message' | 'consent', string>> = {};

  const name = normalizeText(asString(body.name));
  if (name.length < CONTACT_LIMITS.nameMin) {
    errors.name = `Escribe tu nombre (mínimo ${CONTACT_LIMITS.nameMin} caracteres).`;
  } else if (name.length > CONTACT_LIMITS.nameMax) {
    errors.name = `El nombre no puede superar ${CONTACT_LIMITS.nameMax} caracteres.`;
  }

  const email = asString(body.email).trim().toLowerCase();
  if (!email) {
    errors.email = 'Escribe tu correo electrónico.';
  } else if (email.length > CONTACT_LIMITS.emailMax || !EMAIL_PATTERN.test(email)) {
    errors.email = 'El correo no parece válido.';
  }

  // Teléfono opcional: se acepta formato humano, no se guarda como número.
  const rawPhone = normalizeText(asString(body.phone));
  const phone = rawPhone || null;
  if (phone && (phone.length > CONTACT_LIMITS.phoneMax || !/^[+()\d\s.-]+$/.test(phone))) {
    errors.phone = 'El teléfono solo puede tener números, espacios, +, -, ( y ).';
  }

  const message = normalizeMessage(asString(body.message));
  if (message.length < CONTACT_LIMITS.messageMin) {
    errors.message = `Cuéntanos un poco más (mínimo ${CONTACT_LIMITS.messageMin} caracteres).`;
  } else if (message.length > CONTACT_LIMITS.messageMax) {
    errors.message = `El mensaje no puede superar ${CONTACT_LIMITS.messageMax} caracteres.`;
  }

  if (body.consent !== true) {
    errors.consent = 'Debes aceptar la política de privacidad para enviar el mensaje.';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name,
      email,
      phone,
      message,
      source: 'contact_page',
    },
  };
}
