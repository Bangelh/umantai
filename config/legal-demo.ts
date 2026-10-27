/**
 * config/legal-demo.ts — datos legales de DEMOSTRACIÓN (solo fuera de Producción).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  POR QUÉ EXISTEN
 *
 *  Para la revisión visual del cliente en staging, las páginas legales, el Libro
 *  de Reclamaciones y la constancia de seguimiento pueden mostrar datos del
 *  titular de ejemplo en lugar de los `[PENDIENTE: …]`. Son datos FALSOS: el RUC
 *  `00000000000` y los sufijos “— por confirmar” existen para que nadie los
 *  confunda con datos reales.
 *
 *  ESTE MÓDULO ES SOLO CONSTANTES Y PARSEO DE LA BANDERA: no lee variables de
 *  entorno ni toca la base, así que también lo puede importar un componente
 *  cliente. El candado que decide si se muestran (bandera + entorno no
 *  productivo) vive en `config/business.ts` → `isLegalDemoDataActive()`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Bandera explícita que habilita los datos demo (`LEGAL_DEMO_DATA=1`). */
export const LEGAL_DEMO_DATA_FLAG = 'LEGAL_DEMO_DATA';

/** Aviso visible que debe acompañar SIEMPRE a un dato demo (texto exigido). */
export const LEGAL_DEMO_NOTICE = 'DATOS DE DEMOSTRACIÓN — NO VÁLIDOS PARA PRODUCCIÓN';

/**
 * Explicación del aviso. Vive acá, con el resto del contenido legal en español
 * (los documentos que acompaña tampoco se traducen: son un borrador en español
 * pendiente de validación del negocio).
 */
export const LEGAL_DEMO_NOTICE_BODY =
  'Los datos del titular que aparecen en esta página (razón social, RUC, domicilio y ' +
  'jurisdicción) son de ejemplo: existen solo para la revisión visual en staging. No son ' +
  'válidos para el lanzamiento público ni para el cutover, y no deben publicarse en Producción.';

/**
 * Valores de ejemplo. Las claves son los campos todavía pendientes del titular
 * (`PendingBusinessField`), y el valor se reconoce como demo a simple vista.
 */
export const LEGAL_DEMO_VALUES = {
  legalName: 'UMANTAI DEMO S.A.C.',
  ruc: '00000000000',
  address: 'Dirección de demostración — por confirmar',
  jurisdiction: 'Perú — por confirmar',
} as const satisfies Record<'legalName' | 'ruc' | 'address' | 'jurisdiction', string>;

/** `1 | true | yes | on` (sin distinguir mayúsculas) habilita la bandera. */
export function isLegalDemoFlagEnabled(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && /^(1|true|yes|on)$/i.test(raw.trim());
}
