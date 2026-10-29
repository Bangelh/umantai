import { expect, test } from '@playwright/test';

import { E2E_PASSWORD, latestOutbox, loginUi, logoutUi, signUpUi, uniqueEmail } from './helpers';

/**
 * Ciclo de vida de la cuenta en staging:
 * registro → verificación de correo (test-mode) → logout/login →
 * recuperación de contraseña → cambio de contraseña y revocación de sesiones.
 *
 * No depende de Mercado Pago. El correo real no se envía: con `AUTH_TEST_MODE=1`
 * un destinatario `@umantai.test` (dominio reservado) se guarda en
 * `email_outbox` y el endpoint de test lo devuelve a quien presente el header
 * `x-e2e-token`. Los correos de personas reales siguen saliendo por Resend.
 */

test('el outbox de test no responde a quien no trae el token E2E', async ({ request }) => {
  const response = await request.get(
    '/api/auth/test/outbox?email=e2e-probe@umantai.test&purpose=verify_email',
    { headers: { 'x-e2e-token': 'no-es-el-token' } },
  );
  expect(response.status()).toBe(404);
});

test.describe.serial('auth lifecycle', () => {
  const email = uniqueEmail('e2e-auth');
  const newPassword = `${E2E_PASSWORD}-n3w`;

  test('signup crea la cuenta y entra', async ({ page }) => {
    await signUpUi(page, email, 'E2E Auth');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/E2E|Hola/i);
    await expect(page.getByText(email)).toBeVisible();
  });

  test('una cuenta sin verificar puede pedir otro correo desde /cuenta', async ({ page, request }) => {
    // Cuentas anteriores al envío de verificación (o con el correo perdido) no
    // tenían acción: la página solo decía "Correo sin verificar".
    await loginUi(page, email);
    await page.goto('/cuenta');
    await expect(page.getByText('Correo sin verificar')).toBeVisible();

    await page.getByRole('button', { name: /Reenviar correo de verificación/ }).click();
    await expect(page.getByText(/Te enviamos un correo de verificación/)).toBeVisible();

    const resent = await latestOutbox(request, email, 'verify_email');
    expect(resent.actionUrl).toContain('/api/auth/verify-email');
  });

  test('verificación de correo test-mode marca la cuenta como verificada', async ({ page, request }) => {
    const message = await latestOutbox(request, email, 'verify_email');
    await page.goto(message.actionUrl as string);
    await page.goto('/cuenta');
    await expect(page.getByText('Correo verificado')).toBeVisible();
  });

  test('logout y login con la misma contraseña', async ({ page }) => {
    // Cada test de Playwright arranca con un contexto limpio (sin cookies), así
    // que la sesión se crea acá antes de probar el cierre de sesión.
    await loginUi(page, email);
    await logoutUi(page);
    await loginUi(page, email);
    await expect(page.getByText(email)).toBeVisible();
  });

  test('recuperación de contraseña test-mode', async ({ page, request }) => {
    await page.goto('/recuperar');
    await page.getByLabel(/Correo/).fill(email);
    await page.getByRole('button', { name: /Enviar enlace/ }).click();
    await expect(page.getByRole('status')).toContainText(/Si existe una cuenta/i);

    const message = await latestOutbox(request, email, 'reset_password');
    await page.goto(message.actionUrl as string);
    await page.getByLabel(/Nueva contraseña/).fill(newPassword);
    await page.getByLabel(/Repite la nueva contraseña/).fill(newPassword);
    await page.getByRole('button', { name: /Guardar contraseña/ }).click();
    await expect(page.getByText(/Contraseña actualizada/)).toBeVisible();

    await loginUi(page, email, newPassword);
    await expect(page.getByText(email)).toBeVisible();
  });

  test('cambio de contraseña desde la cuenta y revocación de otras sesiones', async ({ page }) => {
    await loginUi(page, email, newPassword);
    await page.goto('/cuenta');
    await page.getByLabel('Contraseña actual').fill(newPassword);
    await page.getByLabel('Nueva contraseña', { exact: true }).fill(E2E_PASSWORD);
    await page.getByLabel('Repite la nueva contraseña').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: /Cambiar contraseña/ }).click();
    await expect(page.getByText('Contraseña actualizada.')).toBeVisible();

    const revoke = page.getByRole('button', { name: /Cerrar las demás sesiones/ });
    if (await revoke.isEnabled()) {
      await revoke.click();
      await expect(page.getByText(/Cerramos las otras sesiones/)).toBeVisible();
    }
  });

  test('login con contraseña incorrecta no revela si el correo existe', async ({ request }) => {
    const wrong = await request.post('/api/auth/sign-in/email', {
      data: { email, password: 'definitely-wrong-password' },
    });
    const missing = await request.post('/api/auth/sign-in/email', {
      data: { email: uniqueEmail('e2e-missing'), password: 'definitely-wrong-password' },
    });
    expect(wrong.status()).toBe(missing.status());
    const wrongBody = (await wrong.text()).replace(email, '<email>');
    const missingBody = (await missing.text()).replace('e2e-missing', '<email>');
    expect(wrongBody).not.toContain('not found');
    expect(missingBody.length).toBeGreaterThan(0);
  });
});
