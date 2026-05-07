import { defineConfig, devices } from '@playwright/test';

const MAC_APP_PORT = process.env.MAC_APP_PORT ?? '5174';

export default defineConfig({
  testDir: './tests-e2e',
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${MAC_APP_PORT}`,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${MAC_APP_PORT}`,
    url: `http://127.0.0.1:${MAC_APP_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
