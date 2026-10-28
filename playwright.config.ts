import { defineConfig, devices } from '@playwright/test';

/**
 * E2E contra un entorno ya desplegado (staging por defecto).
 *
 * No levanta un servidor local: el objetivo es verificar el artefacto real,
 * con sus headers, cookies y base de datos. Para local:
 *   PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test
 *
 * `E2E_TEST_TOKEN` identifica la corrida ante el servidor: habilita la lectura
 * del outbox de correo (`@umantai.test`) y el cupo alto de rate limit. Sin el
 * token la suite sigue corriendo, pero más lenta y sin poder leer enlaces.
 */
const e2eToken = (process.env.E2E_TEST_TOKEN ?? '').trim();
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://web-staging-6756.up.railway.app',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    extraHTTPHeaders: e2eToken ? { 'x-e2e-token': e2eToken } : {},
    ...devices['Desktop Chrome'],
  },
});
