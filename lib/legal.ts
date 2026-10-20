/**
 * lib/legal.ts — contenido de las páginas legales (BORRADORES OPERATIVOS).
 *
 * ⚠️  ESTO NO ES ASESORÍA LEGAL.
 *
 *  Son textos base, redactados para describir lo que la aplicación REALMENTE
 *  hace hoy (checkout, reservas de stock, cookies necesarias, Resend, hosting).
 *  El negocio debe validarlos con un abogado antes de publicarlos como
 *  definitivos, y completar los datos que faltan (razón social, RUC, dirección,
 *  correo legal, plazos y jurisdicción).
 *
 *  Los datos faltantes salen SIEMPRE de `config/business.ts` como
 *  `[PENDIENTE: …]`. Acá no se inventa ningún dato legal, plazo ni jurisdicción.
 */

import { businessConfig, businessValue, pendingLabel, type PendingBusinessField } from '@/config/business';

export const LEGAL_DRAFT_NOTICE =
  'Borrador operativo pendiente de validación del negocio y revisión legal. No constituye asesoría jurídica.';

export const LEGAL_LAST_UPDATED = '2026-10-19';

export interface LegalSection {
  heading: string;
  paragraphs: string[];
}

export interface LegalDocument {
  slug: string;
  title: string;
  /** Para `<meta name="description">`. */
  description: string;
  sections: LegalSection[];
}

const CONTACT_PENDING: PendingBusinessField = 'legalEmail';

/** Contacto legal: correo configurado o placeholder explícito. */
const legalContact = businessValue(CONTACT_PENDING);

export const LEGAL_DOCUMENTS: Record<string, LegalDocument> = {
  privacidad: {
    slug: 'privacidad',
    title: 'Política de Privacidad',
    description:
      'Qué datos personales trata Umantai al comprar, para qué se usan, con quién se comparten y cómo ejercer tus derechos.',
    sections: [
      {
        heading: '1. Quiénes somos y alcance',
        paragraphs: [
          `Esta política describe cómo ${businessConfig.name} trata los datos personales de quienes visitan el sitio, crean una lista de compras, realizan un pedido o usan el kiosco de retiro.`,
          `Responsable del tratamiento: ${businessValue('legalName')}, con domicilio en ${businessValue('address')}. Contacto de privacidad: ${legalContact}.`,
          'El alcance es el sitio y los canales de venta operados por el negocio. No cubre sitios de terceros enlazados.',
        ],
      },
      {
        heading: '2. Qué datos recopilamos',
        paragraphs: [
          'Datos de pedido: correo electrónico de contacto, teléfono (opcional), tipo de entrega, dirección de envío cuando corresponde y el detalle de los productos comprados.',
          'Datos de pago: el sitio no almacena números de tarjeta. El procesamiento lo realiza el proveedor de pagos y solo se conserva la referencia de la operación y su estado.',
          'Datos técnicos: registros de errores y de seguridad del servidor (por ejemplo, intentos fallidos de administración). No se usan para perfilado publicitario.',
          'Cuenta e inicio de sesión: nombre, correo y contraseña (almacenada con hash). Si eres comerciante, también la tienda, tu rol y el plan contratado. No guardamos números de tarjeta ni credenciales del proveedor de cobros.',
          'Suscripciones de comerciantes: plan, estado, fechas de período, eventos de renovación/cancelación y códigos promocionales canjeados. Este historial es necesario para facturar y atender reclamos.',
          'Imágenes que subes (logo o fotos de productos): el archivo, su tipo real, tamaño y la relación con tu tienda o producto. No se conserva el nombre original del archivo ni metadatos del dispositivo.',
          'Preferencias de interfaz: tema (claro/oscuro/sistema) e idioma (español/inglés) en cookies propias. No identifican a la persona ni se usan para publicidad.',
          'Formulario de contacto: nombre, correo, teléfono opcional y el mensaje que nos escribes.',
          'Ubicación (opcional): si pulsas “Usar mi ubicación”, el navegador te pide permiso y nos envía coordenadas aproximadas para mostrar productos y comercios cercanos. No se guarda una ubicación precisa en la base de datos ni se crea un historial de ubicaciones: se mantiene solo en la sesión del navegador y se descarta al cerrar la pestaña. Puedes rechazar el permiso o revocarlo en la configuración del navegador; el buscador sigue funcionando con una zona elegida manualmente.',
        ],
      },
      {
        heading: '3. Para qué los usamos',
        paragraphs: [
          'Para crear y gestionar tu pedido, reservar stock, coordinar el retiro o la entrega, enviarte el aviso de que tu pedido está listo y atender consultas o reclamos.',
          'Para cumplir obligaciones contables o legales que resulten aplicables una vez definidas por el negocio.',
          'Para seguridad del servicio: prevenir fraude, abuso del inventario y accesos no autorizados.',
          'Para mostrar resultados cercanos: usar la ubicación que autorizaste solo durante la búsqueda. Sin tu consentimiento no se solicita ubicación.',
        ],
      },
      {
        heading: '4. Conservación',
        paragraphs: [
          'Los datos del pedido se conservan mientras el pedido esté activo y luego durante el plazo que exija la normativa aplicable, que el negocio debe definir.',
          'Los mensajes de contacto se conservan mientras sean necesarios para atender la consulta.',
          'La ubicación usada para buscar no se almacena de forma persistente: vive en la sesión del navegador y se elimina al cerrarla o al quitarla manualmente.',
        ],
      },
      {
        heading: '5. Con quién se comparten',
        paragraphs: [
          'Con proveedores que hacen posible el servicio: hosting y base de datos, almacenamiento de imágenes (base de datos o almacenamiento de objetos), envío de correos transaccionales y procesamiento de pagos. Solo reciben los datos necesarios para su función.',
          'No vendemos datos personales ni los usamos para publicidad de terceros.',
          'Podemos entregar información cuando exista una obligación legal o un requerimiento válido de autoridad competente.',
        ],
      },
      {
        heading: '6. Tus derechos',
        paragraphs: [
          `Puedes solicitar acceso, rectificación, actualización o eliminación de tus datos escribiendo a ${legalContact}. El plazo de respuesta y el procedimiento formal se definirán con la validación legal (${pendingLabel('jurisdiction')}).`,
          'También puedes solicitar la eliminación de los datos asociados a un pedido, salvo los que deban conservarse por obligación legal o contable.',
        ],
      },
      {
        heading: '7. Seguridad',
        paragraphs: [
          'Las cuentas usan sesiones con cookie HttpOnly y contraseñas almacenadas con hash. El acceso de Platform Admin exige una sesión autenticada y una segunda cookie firmada de corta duración; el token compartido queda solo como respaldo operativo. Las rutas de pago validan la autenticidad de las notificaciones del proveedor y las mutaciones de API verifican el origen.',
          'Ningún sistema es infalible: si detectamos un incidente que afecte datos personales, actuaremos según el procedimiento que defina el negocio con su asesoría legal.',
        ],
      },
      {
        heading: '8. Cambios',
        paragraphs: [
          'Si esta política cambia de forma relevante, se actualizará esta página con la nueva fecha. Las versiones anteriores no se conservan publicadas en el sitio.',
        ],
      },
    ],
  },

  terminos: {
    slug: 'terminos',
    title: 'Términos y Condiciones',
    description:
      'Condiciones de uso del sitio, cómo se forman los pedidos, precios en soles, pagos, retiro, entrega y cancelaciones.',
    sections: [
      {
        heading: '1. Uso del sitio',
        paragraphs: [
          `Al usar el sitio de ${businessConfig.name} aceptas estos términos. Si no estás de acuerdo, no realices pedidos.`,
          'El sitio puede cambiar, suspenderse o dejar de ofrecer productos sin aviso previo. La información del catálogo no constituye una oferta irrevocable.',
        ],
      },
      {
        heading: '2. Productos y precios',
        paragraphs: [
          'Los precios se muestran en soles peruanos (PEN) e incluyen los impuestos que correspondan según la configuración vigente. El negocio debe confirmar el tratamiento tributario aplicable.',
          'Las imágenes y descripciones son referenciales. El stock se reserva al confirmar el pedido y puede agotarse por compras simultáneas.',
        ],
      },
      {
        heading: '3. Pedidos y pagos',
        paragraphs: [
          'Un pedido queda registrado al confirmarse el checkout. La reserva de stock tiene un tiempo limitado; si el pago no se completa, el pedido puede expirar y el stock liberarse.',
          'El pago se procesa a través de un proveedor externo. El pedido se considera pagado cuando el proveedor confirma la operación, no cuando el comprador inicia el pago.',
          'Si un cobro se confirma después de que la reserva venció, el sistema intenta recuperar el stock. Si ya no hay unidades, el negocio contactará al comprador para acordar reembolso o alternativa.',
          'Planes de comerciante (SaaS): los planes Free, Starter y Growth se cobran en dólares estadounidenses (USD), por mes, con los límites de SKU publicados. El cobro recurrente es independiente del pago de los pedidos de tus clientes.',
          'La suscripción se renueva al final de cada período. El comerciante puede cancelar y conservar los beneficios hasta el final del período; después la tienda pasa al plan Free. Un downgrade con exceso de SKU deja la tienda en estado over_limit y bloquea nuevas publicaciones, sin borrar ni ocultar productos ya publicados.',
          'Los códigos promocionales de meses gratis aplican a un plan de pago vigente, no convierten automáticamente una tienda Free en paga y no son transferibles. El cobro real se activará cuando el negocio defina el proveedor; en staging se usa un proveedor manual sin cargos.',
        ],
      },
      {
        heading: '4. Retiro y entrega',
        paragraphs: [
          'En retiro en tienda o locker, el comprador recibe un código o PIN personal. Es responsabilidad del comprador no compartirlo y presentarlo al retirar.',
          'En entrega a domicilio, el comprador debe proporcionar una dirección correcta y un contacto disponible. Los plazos se comunican al confirmar el pedido y dependen de la zona.',
        ],
      },
      {
        heading: '5. Cancelaciones y reembolsos',
        paragraphs: [
          `Las cancelaciones y reembolsos se rigen por la Política de Reembolso. El plazo aplicable todavía no está definido por el negocio (${pendingLabel('refundWindowDays')}).`,
        ],
      },
      {
        heading: '6. Propiedad intelectual',
        paragraphs: [
          `La marca, los textos, el diseño y el código del sitio pertenecen a ${businessConfig.name} o a sus licenciantes. No se permite su uso comercial sin autorización.`,
        ],
      },
      {
        heading: '7. Responsabilidad',
        paragraphs: [
          'El sitio se ofrece "tal cual". No garantizamos disponibilidad ininterrumpida ni ausencia total de errores, aunque trabajamos para mantenerlo operativo.',
          'Nada en estos términos excluye responsabilidades que la ley no permita excluir. Los límites concretos deben validarse legalmente.',
        ],
      },
      {
        heading: '8. Ley aplicable',
        paragraphs: [
          `La jurisdicción aplicable está pendiente de definición por el negocio (${pendingLabel('jurisdiction')}). Mientras tanto, estos términos son un borrador operativo.`,
        ],
      },
    ],
  },

  reembolsos: {
    slug: 'reembolsos',
    title: 'Política de Reembolso',
    description:
      'Cómo solicitar un reembolso o cambio, qué casos se aceptan y cómo se procesa la devolución del dinero.',
    sections: [
      {
        heading: '1. Alcance',
        paragraphs: [
          'Esta política aplica a compras realizadas en el sitio y en el kiosco de retiro. Describe el procedimiento operativo; los plazos legales concretos deben ser validados por el negocio.',
        ],
      },
      {
        heading: '2. Plazo para solicitar',
        paragraphs: [
          `El plazo de reembolso todavía no está definido por el negocio (${pendingLabel('refundWindowDays')}). Hasta que se confirme, cada solicitud se evalúa caso por caso y se responde por el canal de contacto.`,
        ],
      },
      {
        heading: '3. Cuándo corresponde',
        paragraphs: [
          'Producto entregado en mal estado, vencido o distinto al pedido.',
          'Pedido pagado que no pudo entregarse por falta de stock y el comprador no acepta una alternativa.',
          'Cobro duplicado o cobro confirmado sin pedido asociado.',
        ],
      },
      {
        heading: '4. Cuándo no corresponde',
        paragraphs: [
          'Productos perecederos abiertos o consumidos, salvo defecto de origen.',
          'Daños causados por uso indebido después de la entrega.',
          'Solicitudes fuera del plazo que finalmente se defina.',
        ],
      },
      {
        heading: '5. Cómo solicitarlo',
        paragraphs: [
          `Escríbenos con el número de pedido (UM-…) y una descripción del problema a ${legalContact}. Si el problema es con un pago, adjunta la referencia de la operación.`,
          'No envíes datos de tarjeta por correo ni por WhatsApp: no los necesitamos y no deben circular por canales inseguros.',
        ],
      },
      {
        heading: '6. Cómo se procesa',
        paragraphs: [
          'Si la solicitud se aprueba, el reembolso se realiza por el mismo medio de pago utilizado, a través del proveedor de pagos. El tiempo en reflejarse depende del banco o billetera del comprador.',
          'Si el pedido todavía no se retiró, el stock reservado se libera al aprobarse la cancelación.',
        ],
      },
      {
        heading: '7. Productos defectuosos',
        paragraphs: [
          'Si el producto llegó dañado, conserva el empaque y una foto del estado en que lo recibiste para agilizar la evaluación.',
        ],
      },
    ],
  },

  cookies: {
    slug: 'cookies',
    title: 'Política de Cookies y Almacenamiento',
    description:
      'Qué cookies y almacenamiento local usa Umantai realmente: solo lo necesario para el carrito, la sesión y la administración. Sin trackers.',
    sections: [
      {
        heading: '1. Qué usamos hoy',
        paragraphs: [
          'El sitio NO usa cookies de publicidad, píxeles de redes sociales ni analítica de terceros.',
          'Almacenamiento necesario: carrito y lista de compras (localStorage), identificador de sesión de navegación y, si autorizas la ubicación, las coordenadas de esa pestaña (sessionStorage). Nada de eso se usa para publicidad.',
          'Almacenamiento local del navegador (localStorage), estrictamente necesario: carrito de compras, lista de compras, identificador anónimo de sesión del catálogo, token de administración (solo si ingresas al panel) y nombre del actor de inventario.',
          'Cookies de sesión: autentican tu cuenta de UMANTAI (Better Auth) con una cookie HttpOnly de duración limitada. Se crean al ingresar y se eliminan al cerrar sesión. El panel administrativo usa además un token guardado en el navegador, no una cookie.',
        ],
      },
      {
        heading: '2. Necesarias vs. opcionales',
        paragraphs: [
          'Todo lo listado arriba es necesario para que el sitio funcione (carrito, lista, pedido, panel). Sin ello, el carrito o el acceso administrativo no pueden operar.',
          'No hay cookies de analítica ni de marketing en esta versión. Si se incorporan en el futuro, se pedirá consentimiento previo y se actualizará esta página.',
        ],
      },
      {
        heading: '3. Por qué no hay banner',
        paragraphs: [
          'Un banner de consentimiento solo corresponde cuando se instalan cookies no necesarias. Hoy no existen, así que se muestra esta política informativa en lugar de un aviso que bloquee la navegación.',
        ],
      },
      {
        heading: '4. Cómo borrarlas',
        paragraphs: [
          'Puedes borrar el almacenamiento local y las cookies desde la configuración de tu navegador. Al hacerlo se vaciará el carrito, la lista de compras y la ubicación de la pestaña, y se cerrará tu sesión.',
          'Borrar las cookies de sesión del CMS cierra la sesión administrativa.',
        ],
      },
      {
        heading: '5. Cambios',
        paragraphs: [
          'Si se agrega una cookie o un servicio que almacene datos en el dispositivo, esta página se actualizará antes de activarlo.',
        ],
      },
    ],
  },

  'aviso-legal': {
    slug: 'aviso-legal',
    title: 'Aviso Legal',
    description:
      'Datos identificativos del titular del sitio, condiciones de uso de contenidos y limitación de responsabilidad.',
    sections: [
      {
        heading: '1. Titular del sitio',
        paragraphs: [
          `Titular: ${businessValue('legalName')}. RUC: ${businessValue('ruc')}. Domicilio: ${businessValue('address')}.`,
          `Contacto: ${legalContact}.`,
          'Estos datos están pendientes de confirmación por el negocio y se muestran como placeholder a propósito.',
        ],
      },
      {
        heading: '2. Objeto',
        paragraphs: [
          `Este sitio es el canal digital de ${businessConfig.name} para mostrar productos, gestionar pedidos y coordinar su retiro o entrega.`,
        ],
      },
      {
        heading: '3. Propiedad intelectual',
        paragraphs: [
          'Los contenidos, la marca y el código están protegidos por la normativa aplicable. Se prohíbe su reproducción total o parcial sin autorización escrita.',
        ],
      },
      {
        heading: '4. Enlaces externos',
        paragraphs: [
          'Los enlaces a sitios de terceros (por ejemplo, WhatsApp o el proveedor de pagos) se rigen por sus propias políticas. No controlamos ni respondemos por sus contenidos.',
        ],
      },
      {
        heading: '5. Responsabilidad',
        paragraphs: [
          'La información del sitio puede contener errores tipográficos o desactualizaciones. El negocio puede corregirlos sin aviso previo.',
          'La jurisdicción aplicable está pendiente de definición por el negocio.',
        ],
      },
    ],
  },
};

export const LEGAL_SLUGS = Object.keys(LEGAL_DOCUMENTS);

export function getLegalDocument(slug: string): LegalDocument | null {
  return LEGAL_DOCUMENTS[slug] ?? null;
}
