import { defineConfig, devices } from '@playwright/test';

const FRONTEND_PORT = process.env.FRONTEND_PORT ?? '3002';
const BACKEND_PORT = process.env.BACKEND_PORT ?? '3001';

export default defineConfig({
  testDir: './tests-e2e',
  testMatch: /.*\.spec\.ts$/,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

export { FRONTEND_PORT, BACKEND_PORT };
