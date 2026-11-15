/**
 * lib/whatsapp.ts — enlaces de WhatsApp (código compartido cliente/servidor).
 *
 * El número se guarda en `stores.contact_phone`. Lo que escribe el comerciante
 * puede venir con espacios, guiones o con el `+51`; acá se normaliza a lo único
 * que entiende `wa.me`: dígitos con código de país y sin signos.
 *
 * Perú: los celulares tienen 9 dígitos y empiezan con 9. Si llega un número de
 * 9 dígitos se le antepone 51; si ya trae código de país se respeta.
 */

/** `987 654 321` → `51987654321`. `null` si no parece un número usable. */
export function normalizeWhatsAppPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('51')) {
    // 51 + 9 dígitos = 11. Un 51 seguido de menos dígitos no es un celular.
    return digits.length === 11 ? digits : null;
  }

  if (digits.length === 9) return `51${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return digits;
  return null;
}

/** Enlace `wa.me` con mensaje opcional ya escapado. */
export function whatsappUrl(
  phone: string | null | undefined,
  message?: string,
): string | null {
  const number = normalizeWhatsAppPhone(phone);
  if (!number) return null;
  const base = `https://wa.me/${number}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}
