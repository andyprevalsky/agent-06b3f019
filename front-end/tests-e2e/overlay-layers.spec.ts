import { expect, test } from '@playwright/test';
import { FRONTEND_URL } from './helpers';

for (const surface of ['select', 'popover', 'context', 'sheet'] as const) {
  test(`${surface} stays interactive inside a dialog above the composer`, async ({ page }) => {
    page.setDefaultTimeout(5_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${FRONTEND_URL}/tests-e2e/fixtures/overlay-layers.html`);
    await expect(page.getByText('Layer proof', { exact: true })).toBeVisible();
    if (surface === 'select') {
      await page.getByRole('combobox').click();
      await page.getByRole('option', { name: 'Second choice' }).click();
      await expect(page.getByTestId('value')).toHaveText('second');
    } else {
      if (surface === 'popover') await page.getByText('Open popover', { exact: true }).click();
      if (surface === 'context') await page.locator('#context').click({ button: 'right' });
      if (surface === 'sheet') await page.getByText('Open sheet', { exact: true }).click();
      const label = { popover: 'Popover action', context: 'Context action', sheet: 'Sheet action' };
      await page.getByText(label[surface], { exact: true }).click();
      await expect(page.getByTestId('result')).toHaveText(surface);
    }
    expect(errors).toEqual([]);
  });
}
