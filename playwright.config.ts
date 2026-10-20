import { defineConfig, devices } from '@playwright/test';

/**
 * E2E contra un entorno ya desplegado (staging por defecto).
 *
 * No levanta un servidor local: el objetivo es verificar el artefacto real,
 * con sus headers, cookies y base de datos. Para local:
 *   PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test
 */
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
    ...devices['Desktop Chrome'],
  },
});
