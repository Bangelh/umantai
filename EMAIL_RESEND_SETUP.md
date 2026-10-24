# Correo real con Resend — preparación (sin ejecutar todavía)

**Estado:** preparado, **no configurado**. No se creó ninguna cuenta, clave ni
registro DNS: todo lo que sigue requiere acción del negocio/owner.

**Objetivo:** que UMANTAI pueda enviar correo real antes de abrir al público:

1. verificación de cuenta al registrarse;
2. recuperación de contraseña;
3. aviso del formulario de contacto;
4. (ya existente) aviso al comprador cuando el pedido está listo para retirar.

> El código **ya está integrado** con Resend (`resend@^6.28.1`) y probado en
> staging con el proveedor `test` (`email_outbox`). Lo que falta es la parte
> externa: dominio verificado, registros DNS y la API key. No hace falta tocar
> código para habilitarlo.

---

## 1. Qué ya funciona en el código (verificado)

| Flujo | Archivo | Comportamiento sin Resend |
|---|---|---|
| Verificación de cuenta | `lib/auth.server.ts` + `lib/email.server.ts` | La cuenta se crea; el envío falla cerrado y se registra el evento (nunca se imprime el token) |
| Recuperación de contraseña | `lib/auth.server.ts` (`sendResetPassword`) | Respuesta genérica anti-enumeración; el enlace solo se envía si la cuenta existe |
| Formulario de contacto | `lib/contact.server.ts` | El mensaje se guarda en `contact_messages`; la UI informa que el correo no salió |
| Aviso de pedido listo (PIN) | `lib/notifications.server.ts` | El pedido queda listo; el kiosco muestra la advertencia |

Puntos finos que hay que respetar al configurar:

- **`AUTH_TEST_MODE=1` gana sobre la API key**: mientras esté activo, los correos
  de auth se guardan en `email_outbox` y **no salen**. Para la prueba real hay
  que quitarlo; después se restaura para el E2E de staging.
- El remitente por defecto es `Umantai <onboarding@resend.dev>`, que **solo
  entrega al correo dueño de la cuenta de Resend**. No sirve para compradores.
- Los enlaces usan `BETTER_AUTH_URL` / `NEXT_PUBLIC_SITE_URL`; deben apuntar al
  host que esté activo en ese momento (staging hoy, dominio final en el cutover).

---

## 2. Lo que falta y de quién depende

| # | Requisito | Quién | Nota |
|---|---|---|---|
| 1 | Cuenta de Resend y acceso al panel | Negocio | Plan gratuito alcanza para el volumen inicial |
| 2 | Dominio propio para enviar (recomendado: subdominio, ej. `send.<dominio>`) | Negocio | Debe ser un dominio que controlen; no usar `resend.dev` |
| 3 | Acceso al DNS del dominio | Negocio / proveedor de hosting DNS | Los registros se cargan una vez |
| 4 | Buzón para `CONTACT_TO_EMAIL` | **Confirmado** | `juancallerosales19@gmail.com` (ya es el valor central) |
| 5 | Buzón para `LEGAL_EMAIL` | **Confirmado** | `juancallerosales19@gmail.com` (ya se muestra en las páginas legales) |
| 6 | API key con permiso **solo envío** | Negocio | Se pega en Railway; nunca en el repo |
| 7 | Aprobar el cambio de variables y la prueba real | Negocio | Último paso antes de abrir |

No se inventa ningún dato: dominio y remitente salen de lo que confirme el dueño.
Los buzones de contacto y legal ya están confirmados y viven en
`config/business.ts`.

> **Gmail no puede ser el remitente.** `RESEND_FROM_EMAIL` debe usar un dominio
> verificado de UMANTAI (por ejemplo `pedidos@send.<dominio>`). El correo de
> atención/legal es el **destinatario** y el contacto publicado, nunca el `FROM`.

---

## 3. Registros DNS (a copiar del panel de Resend)

Resend muestra los valores exactos al agregar el dominio; **esos son los que
manda**, porque cambian según la región y el subdominio elegido. La forma
esperada, usando `send.<dominio>` como subdominio de envío, es:

| Tipo | Nombre | Valor | Para qué |
|---|---|---|---|
| MX | `send.<dominio>` | `feedback-smtp.<region>.amazonses.com` · prioridad 10 | Rebotes (Return-Path) |
| TXT | `send.<dominio>` | `v=spf1 include:amazonses.com ~all` | **SPF**: autoriza a Resend a enviar |
| TXT | `resend._domainkey.send.<dominio>` | `p=<clave pública DKIM>` | **DKIM**: firma criptográfica |
| TXT | `_dmarc.<dominio>` | `v=DMARC1; p=none; rua=mailto:<buzón-de-reportes>;` | **DMARC** (recomendado) |

Notas obligatorias:

- **Un solo registro SPF por nombre.** Si el dominio ya tiene uno (Google
  Workspace, Microsoft 365, etc.), hay que **fusionar** los `include:` en ese
  mismo TXT; dos TXT `v=spf1` invalidan SPF.
- El DKIM se publica en el subdominio que indique el panel (`resend._domainkey…`).
  No editar ni acortar la clave: un carácter de menos invalida la firma.
- **DMARC empieza en `p=none`** con reportes agregados. Cuando SPF y DKIM pasen
  de forma estable (unos días), subir a `p=quarantine` y luego `p=reject`.
  No arrancar en `reject`.
- Si el dominio raíz ya envía correo de negocio, **no** tocar su SPF/DMARC para
  esta integración: usar el subdominio de envío.
- Propagación típica: minutos; hasta 24–48 h en algunos DNS. Resend marca el
  dominio como *Verified* cuando ve los tres registros.

Checklist:

- [ ] Dominio agregado en Resend y región elegida.
- [ ] MX de rebotes publicado.
- [ ] SPF publicado (y fusionado si ya existía).
- [ ] DKIM publicado completo.
- [ ] DMARC en `p=none` con `rua`.
- [ ] Resend muestra **Verified**.

---

## 4. Variables de entorno (servicio `web`)

```env
# API key de Resend (permiso solo envío). Sin ella no sale ningún correo.
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx

# Remitente del dominio verificado. NO usar onboarding@resend.dev.
RESEND_FROM_EMAIL=Umantai <pedidos@send.<dominio>>

# Destinatario del formulario de contacto. Ya tiene un valor por defecto en
# config/business.ts; solo hace falta declararla para cambiarlo.
CONTACT_TO_EMAIL=juancallerosales19@gmail.com

# Correo legal mostrado en privacidad/términos/reembolsos y aviso legal.
# También tiene valor por defecto en config/business.ts.
LEGAL_EMAIL=juancallerosales19@gmail.com

# Host activo: los enlaces de verificación/reset salen con este origen.
NEXT_PUBLIC_SITE_URL=https://<host activo>
BETTER_AUTH_URL=https://<host activo>
```

Para la prueba real, además:

```env
# QUITAR durante la prueba (si está en 1, los correos van al outbox y no salen).
AUTH_TEST_MODE=

# Decisión de producto: exigir verificación en Producción.
# Recomendado 1 una vez que el correo real funcione.
AUTH_REQUIRE_EMAIL_VERIFICATION=1
```

`CONTACT_TO_EMAIL` y `LEGAL_EMAIL` se leen en `config/business.ts`, con el correo
confirmado como valor por defecto: las páginas ya no muestran
`[PENDIENTE: definir correo legal]`. Lo que falta para que salga correo real es
`RESEND_API_KEY` y un `RESEND_FROM_EMAIL` de dominio verificado.

---

## 5. Prueba real (cuando estén la cuenta, el dominio y la key)

Se hace **contra staging**, con un buzón real (no `@umantai.test`), y se repite
en Producción después del cutover.

### 5.1 Verificación de cuenta

1. Quitar `AUTH_TEST_MODE` y redesplegar `web`.
2. Registrarse con un correo real.
3. Confirmar que el correo llega **desde el dominio verificado** (no desde
   `resend.dev`), en bandeja de entrada (no spam).
4. Abrir el enlace: la cuenta queda verificada (`users."emailVerified" = true`)
   y la sesión se inicia.
5. Probar “Reenviar correo de verificación”.

### 5.2 Recuperación de contraseña

1. Pedir recuperación para esa cuenta.
2. Confirmar recepción y que el enlace vence en 1 hora.
3. Cambiar la contraseña y verificar que las sesiones anteriores se revocaron.
4. Pedir recuperación para un correo inexistente: misma respuesta, sin correo
   (anti-enumeración).

### 5.3 Formulario de contacto

1. Enviar un mensaje desde `/contacto` con datos válidos.
2. Confirmar que el aviso llega a `CONTACT_TO_EMAIL` **y** que la fila quedó en
   `contact_messages`.
3. Confirmar que un fallo de Resend no rompe el formulario (el mensaje se guarda
   igual y la UI lo informa).

### 5.4 Aviso de pedido listo (ya existente)

1. Crear un pedido de prueba y marcarlo listo para retirar desde operación.
2. Confirmar el correo al comprador con el PIN.

### 5.5 Entregabilidad

- [ ] Cabeceras muestran `spf=pass`, `dkim=pass`, `dmarc=pass`.
- [ ] Sin rebotes ni quejas en el panel de Resend.
- [ ] Revisar los reportes DMARC a los 2–3 días.
- [ ] Restaurar `AUTH_TEST_MODE=1` en staging si se sigue usando el E2E con
      outbox (o actualizar el E2E si se deja el envío real).

---

## 6. Riesgos y rollback

| Riesgo | Mitigación |
|---|---|
| SPF duplicado invalida el dominio | Fusionar en un único TXT antes de verificar |
| DKIM incompleto | Copiar el valor completo del panel; no reescribirlo a mano |
| Correos a spam | Subdominio de envío, DMARC en `none`, probar con Gmail y Outlook |
| `AUTH_TEST_MODE` olvidado | Revisar la variable antes de dar por buena la prueba |
| Remitente no verificado | El envío falla cerrado; la app no se rompe, pero no llega el correo |
| Fuga de la API key | Solo en Railway, permiso de envío, rotarla si se expuso |

**Rollback:** borrar `RESEND_API_KEY` (o volver a `AUTH_TEST_MODE=1`). El
registro, el checkout y el formulario siguen funcionando con degradación
explícita; no hay que revertir código.

---

## 7. Orden de ejecución (cuando el dueño dé los datos)

1. Crear cuenta en Resend y agregar el subdominio de envío.
2. Publicar MX, SPF, DKIM y DMARC; esperar *Verified*.
3. Crear la API key (solo envío).
4. Cargar las cinco variables en Railway `staging` → `web`; quitar
   `AUTH_TEST_MODE`; redesplegar.
5. Ejecutar 5.1 → 5.4 con un buzón real.
6. Revisar entregabilidad (5.5) y restaurar el modo de test si corresponde.
7. Repetir en Producción **después** del cutover, no antes.
