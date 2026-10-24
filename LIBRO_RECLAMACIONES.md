# Libro de Reclamaciones — auditoría para lanzamiento público en Perú

**Fecha:** 2026-10-24 · **Estado:** requisito identificado, **NO implementado** ·
**Bloquea el lanzamiento público:** sí (ver §4).

Este documento no es asesoría legal. Resume el requisito, lo que falta en el
producto y una opción mínima compatible con la arquitectura actual. La
implementación y el texto final deben validarse con asesoría legal.

---

## 1. Requisito

En Perú, todo proveedor que atiende al público debe poner a disposición de los
consumidores un **Libro de Reclamaciones**, físico o virtual, en cada
establecimiento y en las plataformas de venta por internet.

- **Código de Protección y Defensa del Consumidor (Ley N.º 29571).**
- **Reglamento del Libro de Reclamaciones (D.S. N.º 011-2011-PCM).** Define el
  formato (Anexo I) y el aviso visible (Anexo II).
- **Ley N.º 32495 (noviembre 2025).** Incorporó expresamente a las **plataformas
  digitales de comercio electrónico** a la obligación y exige un enlace
  **permanente, visible y fácilmente accesible** al Libro de Reclamaciones en el
  portal o aplicación. Su entrada en vigor quedó condicionada a la adecuación
  del Reglamento; la obligación de fondo para ventas por internet ya existía.

Puntos operativos que impactan el diseño:

| Punto | Exigencia |
|---|---|
| Plazo de respuesta | **15 días hábiles improrrogables**, por escrito, para quejas y reclamos |
| Acceso | En el mismo medio virtual donde se vende, con aviso visible |
| Copia | El libro virtual debe permitir **imprimir o enviar una copia** al correo del consumidor |
| Contenido mínimo (Anexo I) | Numeración correlativa · razón social, RUC y dirección del proveedor · fecha · nombre, DNI, teléfono y correo del consumidor · descripción y monto del bien/servicio · detalle del reclamo o queja · pedido concreto · espacio para acciones/observaciones del proveedor |
| Costo | La atención no puede condicionarse a ningún pago |

INDECOPI publica los formatos y el aviso sin costo en
<https://consumidor.indecopi.gob.pe/tulibro/> («Tu Libro»). No hace falta
contratar un proveedor externo para cumplir.

> Verificación pendiente: confirmar con asesoría legal la vigencia exacta del
> Reglamento adecuado a la Ley N.º 32495 a la fecha del lanzamiento. Aun si esa
> adecuación siguiera pendiente, el Libro de Reclamaciones virtual ya es exigible
> para ventas por internet.

---

## 2. Qué hay hoy en UMANTAI

| Pieza | Estado |
|---|---|
| Página o enlace al Libro de Reclamaciones | **No existe** |
| Formulario con los campos del Anexo I | **No existe** |
| Registro persistente con numeración correlativa | **No existe** |
| Copia/constancia para el consumidor | **No existe** |
| Bandeja de atención y respuesta con plazo | **No existe** |
| Aviso visible en footer / checkout | **No existe** |
| Datos del proveedor para la hoja (razón social, RUC, domicilio) | **Pendientes** en `config/business.ts` |

Lo que **sí** se puede reutilizar:

- `app/contacto` y `lib/contact.ts` / `lib/contact.server.ts`: validación,
  honeypot, rate limit y persistencia con degradación explícita.
- `lib/notifications.server.ts` (Resend): envío de la constancia al consumidor.
- PostgreSQL + migraciones (`db/migrations`): tabla y secuencia correlativa.
- `app/admin/*` y `lib/admin-route.server.ts`: bandeja interna para responder.
- `config/business.ts`: datos del titular en un solo lugar.

---

## 3. Opción mínima compatible con la arquitectura actual

Sin servicios externos y sin contratar nada:

1. **Ruta pública `/libro-de-reclamaciones`** (español, `lang="es"`), con el
   aviso de INDECOPI y los campos del Anexo I. Mismo patrón que `/contacto`:
   validación server-side, honeypot y rate limit.
2. **Tabla `consumer_complaints`** con: número correlativo (secuencia), tipo
   (queja/reclamo), datos del consumidor (nombre, DNI, teléfono, correo),
   descripción del bien/servicio y monto, detalle, pedido concreto, fecha/hora,
   estado, respuesta del proveedor, fecha de respuesta y vencimiento a 15 días
   hábiles.
3. **Constancia inmediata**: pantalla con el número correlativo + envío de copia
   al correo del consumidor vía Resend. Si Resend no está configurado, la
   constancia se muestra igual y queda registrada (mismo criterio que el
   formulario de contacto: nunca fingir que se envió).
4. **Bandeja `/admin/reclamaciones`**: listar, ver vencimiento, responder y
   cerrar; registrar la fecha de respuesta.
5. **Enlace visible** en el footer (junto a los documentos legales), en
   `/contacto` y en la página del pedido.
6. **Actualizar** la Política de Privacidad (datos DNI/teléfono y finalidad) y
   los Términos para mencionar el canal.

Tamaño estimado: una migración, una ruta pública, una API, una pantalla de
administración y sus tests. No requiere dependencias nuevas.

**Datos que faltan para poder implementarlo bien:** razón social, RUC y
domicilio fiscal (los mismos placeholders de `config/business.ts`). Sin ellos la
hoja de reclamación estaría incompleta, así que no se debe publicar.

---

## 4. ¿Bloquea la publicación pública?

**Sí, como requisito legal independiente.** No es un tema de Mercado Pago ni de
pagos: aplica aunque el cobro online siga congelado, porque el sitio ya ofrece
productos y recibe pedidos de consumidores en Perú.

Recomendación: tratarlo como **GO/NO-GO propio** en el cutover, con estas dos
condiciones:

- [ ] Libro de Reclamaciones virtual accesible y funcional (registra, numera y
      entrega constancia).
- [ ] Aviso visible enlazado desde el footer y desde el checkout/pedido.

Mientras no exista, el lanzamiento público queda expuesto a sanciones de
INDECOPI. Staging puede seguir sin él, pero no debe abrirse al público sin
resolverlo.

---

## 5. Lo que NO se debe hacer

- Publicar un enlace a un formulario que no guarda ni responde: la obligación
  incluye atender en 15 días hábiles y poder acreditar la hoja.
- Copiar un formato de terceros sin verificar que cumple el Anexo I.
- Inventar razón social, RUC o domicilio para completar la cabecera.
- Condicionar la presentación del reclamo al pago o a una compra previa.

---

## 6. Acciones externas necesarias

Ninguna compra ni contratación. Solo:

1. **Dueño:** entregar razón social, RUC y domicilio fiscal (hoy `[PENDIENTE]`).
2. **Asesoría legal:** validar el texto, el aviso y el flujo de respuesta.
3. **Negocio:** definir responsable y canal interno para responder dentro de 15
   días hábiles.

Con esos tres puntos se implementa la opción mínima del §3 y se agrega al
checklist del cutover.
