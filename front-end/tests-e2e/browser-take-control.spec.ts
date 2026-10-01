/**
 * Semantic Test: Take control from the live browser status chip.
 *
 * Boots the real frontend in Chromium against the running local stack, seeds a
 * real browser session row for the task, and walks the production UI path:
 *   browser status chip -> expand -> fullscreen -> Take control -> Hand back
 *
 * Also posts a navigation message (new browser_url) after taking control to
 * cement the regression where URL churn used to drop user ownership.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  BACKEND_URL,
  FRONTEND_URL,
  HAS_INJECTED_SESSION,
  IS_PROD,
  TEST_API_KEY,
  attachRecorder,
  createAgent,
  deleteAgent,
  expectDevAuthenticated,
  expectInjectedSessionRecognized,
  hasUncaughtErrors,
  injectSemanticSession,
  resolveTestUserId,
} from './helpers';

const LIVE_VIEW_V1 = 'https://example.com/take-control-v1';
const LIVE_VIEW_V2 = 'https://example.com/take-control-v2';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const seedScript = path.join(repoRoot, 'back-end/scripts/seed-browser-take-control-e2e.ts');
const LOCAL_DATABASE_URL = (() => {
  if (process.env.SEMANTIC_DATABASE_URL) return process.env.SEMANTIC_DATABASE_URL;
  // Deploy / run.sh isolate Postgres on LOCAL_DB_PORT (base+5). Seeding 5432
  // while the backend reads that isolated DB makes Take control 404 and stall.
  if (process.env.LOCAL_DB_PORT) {
    return `postgresql://postgres:postgres@localhost:${process.env.LOCAL_DB_PORT}/victoria?connection_limit=50&pool_timeout=30`;
  }
  return 'postgresql://postgres:postgres@localhost:5432/victoria?connection_limit=50&pool_timeout=30';
})();

async function seedBrowserControlSession(
  agentId: string,
  taskId: string,
  userId: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      execFileSync('npx', ['tsx', seedScript], {
        cwd: path.join(repoRoot, 'back-end'),
        env: {
          ...process.env,
          ALLOW_E2E_DB_SEED: '1',
          DATABASE_URL: LOCAL_DATABASE_URL,
          DIRECT_URL: process.env.SEMANTIC_DIRECT_URL ?? LOCAL_DATABASE_URL,
          AGENT_ID: agentId,
          TASK_ID: taskId,
          USER_ID: userId,
          DEBUG_URL: LIVE_VIEW_V1,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      return;
    } catch (error) {
      // The concurrent E2B gate regenerates Prisma's native client in this
      // workspace. Retry only the brief window when its dylib is being replaced.
      const stderr = (error as { stderr?: string }).stderr ?? '';
      if (!stderr.includes('segment __TEXT extends beyond end of file') || attempt === 5) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

async function postToolMessage(
  agentId: string,
  metadata: Record<string, unknown>,
  text = '',
): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/agents/${agentId}/messages`, {
    method: 'POST',
    headers: { 'X-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, role: 'TOOL', metadata }),
  });
  if (!res.ok) {
    throw new Error(`postToolMessage failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

async function openFullscreenFromChip(page: import('@playwright/test').Page): Promise<void> {
  const chip = page.locator('[data-testid="browser-status-chip"]');
  await expect(chip).toBeVisible();
  await chip.click();
  const browserHeading = page.getByRole('heading', { name: "Agent's Browser", exact: true });
  await expect(browserHeading).toBeVisible();
  const header = browserHeading.locator('xpath=ancestor::div[2]');
  const buttons = header.getByRole('button');
  const count = await buttons.count();
  await buttons.nth(Math.max(0, count - 2)).click();
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('browser-take-control', () => {
  // Direct DB seed is local-only; production semantic cannot write BrowserSession rows.
  test.skip(IS_PROD, 'Take-control seed requires local DB; skip against production');

  test('user can take and hand back control from the browser status chip', async ({ page }) => {
    const rec = attachRecorder(page);
    const agentId = await createAgent('Semantic test: browser take control via status chip.');
    const taskId = randomUUID();
    const userId = await resolveTestUserId();

    try {
      await seedBrowserControlSession(agentId, taskId, userId);

      await postToolMessage(agentId, {
        toolCallId: 'call-take-control',
        toolName: 'spawn_browser_agent',
        toolStatus: 'IN_PROGRESS',
        action_type: 'session_started',
        task_id: taskId,
        browser_url: LIVE_VIEW_V1,
        title: 'Browser ready for take control',
      });

      if (HAS_INJECTED_SESSION) {
        await injectSemanticSession(page);
      }
      await page.goto(`${FRONTEND_URL}/?agent-id=${agentId}`, {
        waitUntil: 'domcontentloaded',
      });
      if (HAS_INJECTED_SESSION) {
        await expectInjectedSessionRecognized(page);
      } else {
        await expectDevAuthenticated(page, rec);
      }

      await expect(
        page.getByTestId('browser-status-chip').getByText('Browser ready for take control'),
      ).toBeVisible({
        timeout: 30_000,
      });
      await openFullscreenFromChip(page);

      await page.getByRole('button', { name: 'Take control', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Hand back control', exact: true }),
      ).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.locator('iframe[title="Browser"]')).toHaveAttribute(
        'src',
        /interactive=true/,
      );

      // Agent navigation updates the live URL — ownership must survive even in fullscreen.
      await postToolMessage(agentId, {
        toolCallId: 'call-take-control',
        toolName: 'spawn_browser_agent',
        toolStatus: 'IN_PROGRESS',
        action_type: 'navigate',
        task_id: taskId,
        browser_url: LIVE_VIEW_V2,
        title: 'Navigated to cart',
      });
      await expect(
        page.getByRole('button', { name: 'Hand back control', exact: true }),
      ).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator('iframe[title="Browser"]')).toHaveAttribute(
        'src',
        /interactive=true/,
      );

      await page.getByRole('button', { name: 'Hand back control', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible({
        timeout: 30_000,
      });

      // Hand back must release browser ownership so the browser worker can resume reasoning.
      const session = process.env.SEMANTIC_SESSION;
      const bearerHeaders =
        session !== undefined && session !== ''
          ? { Authorization: `Bearer ${JSON.parse(session).access_token}` }
          : { 'X-API-Key': TEST_API_KEY, 'X-User-Id': userId };
      await expect
        .poll(async () => {
          const res = await fetch(`${BACKEND_URL}/api/browser-session/task/${taskId}/control`, {
            headers: bearerHeaders,
          });
          if (!res.ok) return 'unavailable';
          const snapshot = (await res.json()) as { state?: string };
          return snapshot.state ?? 'unknown';
        })
        .toBe('agent');

      expect(hasUncaughtErrors(rec), 'Uncaught errors during take-control flow').toEqual([]);
    } finally {
      await deleteAgent(agentId);
    }
  });
});
