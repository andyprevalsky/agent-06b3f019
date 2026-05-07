import { expect, test } from '@playwright/test';

test.describe('mac-app renderer preload bridge', () => {
  test('renders without crashing when Electron preload bridge is unavailable', async ({ page }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];

    page.on('pageerror', (error) => {
      pageErrors.push(String(error));
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();

    await page.waitForTimeout(1_000);

    const preloadBridgeErrors = [...pageErrors, ...consoleErrors].filter(
      (message) =>
        message.includes('onUpdateStatus') ||
        message.includes('onQuickQuerySubmit') ||
        message.includes('Cannot read properties of undefined')
    );

    expect(preloadBridgeErrors).toEqual([]);
  });
});
