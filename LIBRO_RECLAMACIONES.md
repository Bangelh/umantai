# Libro de Reclamaciones — implementación y estado para lanzamiento

**Fecha:** 2026-10-24 · **Estado:** aprobado técnicamente en staging · **Bloqueo
restante:** datos del titular (razón social, RUC, domicilio, jurisdicción) y
revisión legal del texto/aviso. No se inventó ningún dato.

**Responsable operativo inicial:** el Platform Admin de UMANTAI. No se publica
su nombre personal en el formulario ni en la constancia; queda registrado en la
bandeja para auditoría.

Este documento no es asesoría legal. Resume el requisito, lo implementado y lo
que falta antes de abrir UMANTAI al público.

---

## 1. Requisito

En Perú, todo proveedor que atiende al público debe poner a disposición de los
consumidores un **Libro de Reclamaciones**, físico o virtual, en cada
establecimiento y en las plataformas de venta por internet.

- **Código de Protección y Defensa del Consumidor (Ley N.º 29571).**
- **Reglamento del Libro de Reclamaciones (D.S. N.º 011-2011-PCM).** Define el
  formato (Anexo I) y el aviso visible (Anexo II).
- **Ley N.º 32495 (noviembre 2025).** Incorporó expresamente a las **plataformas
  digitales de comercio electrónico** y exige un enlace **permanente, visible y
  fácilmente accesible** al Libro de Reclamaciones.

| Punto | Exigencia | Cómo se cumple |
|---|---|---|
| Plazo de respuesta | **15 días hábiles improrrogables** | `due_at` calculado en el servidor y visible en admin/constancia |
| Acceso | En el mismo medio virtual, con aviso visible | Enlace en footer, contacto, legal, checkout y pedido |
| Copia | Imprimir o enviar copia al correo | Constancia imprimible + envío por Resend (preparado) |
| Contenido mínimo (Anexo I) | Numeración, proveedor, fecha, consumidor, bien/servicio, detalle, pedido, observaciones | Ver §3 |
| Costo | No condicionar a pago | Formulario público sin pago |

---

## 2. Implementación

| Pieza | Dónde |
|---|---|
| Migración | `db/migrations/023_consumer_complaints.sql`, `db/migrations/024_complaint_assignment.sql` |
| Dominio + plazo | `lib/complaints.ts` |
| Calendario de feriados | `lib/peru-holidays.ts` (versionado) |
| Persistencia | `lib/complaints.server.ts` |
| Constancia/respuesta por correo | `lib/complaints-email.server.ts` |
| API pública | `POST /api/complaints` |
| Página pública | `/libro-de-reclamaciones` |
| Constancia y seguimiento | `/libro-de-reclamaciones/seguimiento/<código>` |
| API admin | `GET /api/admin/complaints`, `GET|PATCH /api/admin/complaints/:id` |
| Bandeja | `/admin/reclamaciones` |
| Enlaces | footer, `/contacto`, `/legal`, `/legal/[slug]`, `/cart`, `/pedido/[token]` |

### Campos guardados

Número correlativo (`RC-000001`), código público aleatorio, tipo
(reclamo/queja), nombre, documento, teléfono y correo del consumidor, condición
de menor y datos del padre/madre/tutor cuando corresponde, producto/servicio,
monto (opcional, PEN), detalle, pedido concreto, estado, acciones/observaciones
del proveedor, respuesta, fecha de presentación, fecha límite y fecha de
respuesta.

No se guarda nada más: no hay IP, user-agent ni metadatos del navegador.

### Constancia

Al registrar se muestra una página con el número correlativo, los datos del
proveedor, el detalle, la fecha límite y un botón **Imprimir o guardar PDF**.
Se envía copia al correo del consumidor cuando Resend está configurado; si no,
la constancia se muestra igual y el estado del correo queda `not_configured`
(nunca se finge un envío). El registro funciona aunque Resend esté apagado.

### Seguimiento sin login

El enlace usa un **código aleatorio de 144 bits** (base64url, 24 caracteres),
no el correlativo. Sin el código no se puede enumerar ni adivinar una
constancia; el correlativo (`RC-000001`) responde 404 en la ruta de seguimiento.
La vista pública no devuelve DNI, teléfono ni correo.

### Admin

`/admin/reclamaciones` exige **sesión de Platform Admin** (cookie firmada). La
API rechaza el token compartido (`x-admin-token`) porque muestra datos
personales. Permite listar, filtrar por estado/tipo/fecha, abrir el detalle,
marcar en revisión y registrar una respuesta única (no se sobrescribe). No hay
borrado desde la UI ni endpoint `DELETE`.

La bandeja muestra:

- **responsable asignado** (`assigned_to`); al registrarse es el rol
  `Platform Admin (UMANTAI)` y al tomar la hoja queda el correo del admin;
- **estado** (recibido, en revisión, atendido);
- **fecha límite** y **días de alerta**: rojo si está vencido, ámbar si vence en
  los próximos 3 días, con contadores de pendientes/por vencer/vencidos;
- **historial mínimo de respuesta**: texto de la respuesta, acciones u
  observaciones, fecha y autor (`answered_by`).

### Plazo y feriados

El cómputo cuenta **15 días hábiles desde el día siguiente**, en la zona
`America/Lima`, excluyendo sábado, domingo y los **feriados nacionales** del
calendario versionado en `lib/peru-holidays.ts` (versión
`2026-2027.1`, 16 feriados por año). El vencimiento se fija a las 23:59:59 de
Lima.

Solo se excluyen feriados **nacionales**. Los feriados regionales y los días no
laborables compensables no detienen el plazo para todo el país y no se cuentan.
Los feriados peruanos no se trasladan al lunes: rige la fecha exacta, incluso si
cae en fin de semana.

**Actualización anual del calendario:**

1. Agregar el año en `CALENDARS` de `lib/peru-holidays.ts` con los feriados
   nacionales publicados por el Estado (D.L. 713 y modificatorias). No inventar
   ni copiar el año anterior: Jueves/Viernes Santo cambian y pueden aparecer
   feriados por decreto.
2. Subir `PERU_HOLIDAY_CALENDAR_VERSION` (por ejemplo `2028.1`).
3. Agregar/ajustar el test de 16 feriados y el de un plazo que cruce un feriado
   de ese año.
4. Desplegar antes del 1 de enero del año nuevo.

**Fail-safe:** si un plazo atraviesa un año sin calendario, el sistema no se
cae ni bloquea el registro. Calcula solo con fines de semana y lo advierte en
la bandeja; como no descuenta feriados, el vencimiento puede quedar **antes**
del máximo legal, nunca después. La solución correcta sigue siendo cargar el
año. Para feriados puntuales declarados por decreto después del deploy se puede
usar `PERU_HOLIDAYS` (ver `ENVIRONMENT_VARIABLES.md`), que agrega fechas pero no
marca un año como completo.

---

## 3. Seguridad y privacidad

- Validación server-side con límites de longitud y formatos
  (`lib/complaints.ts`); el HTML no decide.
- CSRF por `Origin` en `proxy.ts` para todas las mutaciones de `/api`.
- Rate limit del formulario: 5 envíos / 10 min por IP.
- Honeypot `company` con respuesta neutra.
- Cuerpo máximo 32 KB; respuestas de admin 12 KB.
- Render seguro: React escapa; no se usa `dangerouslySetInnerHTML`; los correos
  se envían en texto plano.
- Sin PII en URLs de admin ni en logs; el código público es la única llave de
  seguimiento.
- `robots: noindex` en la constancia.
- Migración con `CHECK` para estados, moneda y campos de respuesta.
- La Política de Privacidad (`lib/legal.ts`) describe los datos del reclamo, la
  finalidad y su conservación como evidencia.

---

## 4. ¿Bloquea la publicación pública?

La **funcionalidad ya no bloquea**. Lo que sigue bloqueando es:

- [ ] Razón social, RUC, domicilio fiscal y jurisdicción confirmados. Mientras
      falten, el formulario y la constancia muestran `[PENDIENTE: …]` y el aviso
      “no listo para lanzamiento público”.
- [ ] Revisión legal del texto del formulario, del aviso y del flujo de
      respuesta.

Resuelto técnicamente: responsable operativo (Platform Admin) y calendario de
feriados nacionales 2026–2027 con fail-safe documentado.

El enlace al Libro ya está visible en footer, contacto, legal y checkout/pedido.

---

## 5. Pruebas

- `tests/complaints.test.ts`: validación, menores, honeypot, monto, XSS como
  dato, correlativo, código opaco, plazo con feriados (Fiestas Patrias, fin de
  año, feriado adicional) y fail-safe de un año sin calendario.
- `tests/complaints.integration.test.ts`: PostgreSQL real (migraciones 023 y
  024), correlativo, consulta sin PII, filtros, responsable, autor de la
  respuesta, revisión, respuesta única y autorización estricta de las rutas
  admin.
- `e2e/public.spec.ts`: registro real, constancia imprimible, XSS escapado y
  no enumeración.
- `e2e/admin.spec.ts`: puerta de sesión y navegación del panel.

---

## 6. Acciones externas necesarias

Ninguna compra ni contratación.

1. **Dueño:** entregar razón social, RUC y domicilio fiscal.
2. **Asesoría legal:** validar textos, aviso y plazos.
3. **Negocio:** confirmar que el Platform Admin asume la bandeja y mantener
   actualizado el calendario anual de feriados antes de cada 1 de enero.
