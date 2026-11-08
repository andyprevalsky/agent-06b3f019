import { defineConfig, devices } from '@playwright/test';

const FRONTEND_PORT = process.env.FRONTEND_PORT ?? '3002';
const BACKEND_PORT = process.env.BACKEND_PORT ?? '3001';
const BASE_URL = process.env.FRONTEND_URL ?? `http://localhost:${FRONTEND_PORT}`;

export default defineConfig({
  testDir: './tests-e2e',
  testMatch: /.*\.spec\.ts$/,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // Deploy gates only: one retry, and a retried pass is reported FLAKY by the progress reporter.
  retries: process.env.DEPLOY_GATE_PROGRESS ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    // Live deploy-gate failure rows, only when the gate worker names a progress file.
    ...(process.env.DEPLOY_GATE_PROGRESS
      ? [['./src/tests/gate-progress/playwrightReporter.ts'] as [string]]
      : []),
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

export { FRONTEND_PORT, BACKEND_PORT };
