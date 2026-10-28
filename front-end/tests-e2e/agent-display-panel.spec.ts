/** Real inline display + opaque WebGL iframe, with deterministic local API fixtures. */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { FRONTEND_URL } from './helpers';
const OWNER = 'display-preview';
const GAME_URL = 'https://display-preview.rose.test/game.html';
const html = readFileSync(new URL('./fixtures/agent-display-game.html', import.meta.url), 'utf8');

test('desktop inline display runs real WebGL output and keeps controls in its sandbox', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const user = { id: 'display-preview-user', is_anonymous: false };
    localStorage.setItem('app-user', JSON.stringify(user));
    localStorage.setItem(
      'rose-session',
      JSON.stringify({
        user,
        access_token: 'fixture',
        refresh_token: 'fixture',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
  });
  const now = new Date().toISOString();
  const agent = {
    agent_id: OWNER,
    title: 'Build a 3D game',
    goal: 'Build a 3D game',
    model: 'rose-1-flash',
    source: 'WEB',
    status: 'COMPLETED',
    progress: 100,
    created_at: now,
    updated_at: now,
    parent_agent_id: null,
    tools: [],
    message_count: 2,
    context_size: 0,
    token_count: 0,
    price_limit_cents: 100,
    tree_cost_cents: 0,
  };
  await page.route(GAME_URL, (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    let body: unknown = {};
    if (path === '/api/agents') body = { agents: [agent] };
    else if (path === `/api/agents/${OWNER}`)
      body = {
        agent,
        pagination: { has_more: false, oldest_timestamp: null },
        messages: [
          { message_id: 'user', timestamp: now, role: 'USER', text: 'Build a 3D game' },
          {
            message_id: 'game-display',
            timestamp: now,
            role: 'ASSISTANT',
            text: '',
            metadata: {
              display: {
                kind: 'media',
                placement: 'inline',
                media_kind: 'page',
                mime_type: 'text/html',
                caption: 'Orbit Runner',
                canonical_id: 'orbit-runner',
              },
            },
            file_pointer: {
              id: 'game',
              original_filename: 'game.html',
              storage_path: 'display/game.html',
              mime_type: 'text/html',
              size_bytes: html.length,
              created_at: now,
              usercontent_url: GAME_URL,
            },
          },
        ],
      };
    else if (path === '/api/agents/code-agents') body = { code_agents: [] };
    else if (path === '/api/agents/tree') body = { agents: [] };
    else if (path === '/api/projects') body = { projects: [] };
    else if (path === '/api/attention-requests') body = { requests: [] };
    else if (path === '/api/invite-codes/check') body = { needsInviteCode: false };
    await route.fulfill({ json: body });
  });
  await page.goto(`${FRONTEND_URL}/?agent-id=${OWNER}`, { waitUntil: 'domcontentloaded' });
  // 134fc78cc removed the Agent Display icon/panel: every display renders
  // inline in the chat, collapsed to a preview with a chevron disclosure.
  await expect(page.getByRole('button', { name: 'Browser', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Agent Display', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('agent-display-drawer')).toHaveCount(0);
  const toggle = page.getByRole('button', { name: 'Expand display: Orbit Runner', exact: true });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const item = page.locator('[data-message-kind="display-media"]');
  const iframe = item.getByTestId('display-html-frame');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-popups');
  const game = page.frameLocator('[data-message-kind="display-media"] iframe');
  const canvas = game.locator('canvas');
  // The collapsed preview already runs the live frame.
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await iframe.evaluate((el) => el.setAttribute('data-probe', 'same-frame'));
  await toggle.click();
  const collapse = page.getByRole('button', { name: 'Collapse display: Orbit Runner' });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await expect(item).toHaveAttribute('data-expanded', 'true');
  // Expanding resizes the same frame element instead of remounting it.
  await expect(iframe).toHaveAttribute('data-probe', 'same-frame');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await canvas.click();
  const x = Number(await canvas.getAttribute('data-x'));
  await page.keyboard.down('ArrowRight');
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-x')))
    .toBeGreaterThan(x + 0.2);
  await page.keyboard.up('ArrowRight');
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-frames')))
    .toBeGreaterThan(3);
  // Collapsing back to the preview keeps the same live frame running.
  await collapse.click();
  await expect(item).toHaveAttribute('data-expanded', 'false');
  await expect(iframe).toHaveAttribute('data-probe', 'same-frame');
  const frames = Number(await canvas.getAttribute('data-frames'));
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-frames')))
    .toBeGreaterThan(frames);
  // The final segment is retained as a user-facing clip with the display expanded.
  await page.getByRole('button', { name: 'Expand display: Orbit Runner' }).click();
  await page.waitForTimeout(1500);
  await canvas.click();
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(700);
  await page.keyboard.up('ArrowLeft');
  await page.keyboard.press('Space');
  await page.waitForTimeout(7000);
});
