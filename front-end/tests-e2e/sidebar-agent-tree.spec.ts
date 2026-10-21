/** Actual sidebar screenshots with deterministic agent trees; no live agents. */
import { expect, test, type Page } from '@playwright/test';
import { FRONTEND_URL } from './helpers';
const ROOT = 'launch-root';
async function openSidebarPreview(page: Page, width: number) {
  await page.setViewportSize({ width, height: 820 });
  await page.addInitScript(() => {
    const user = { id: 'sidebar-preview-user', is_anonymous: false };
    localStorage.setItem('app-user', JSON.stringify(user));
    localStorage.setItem('rose-theme:sidebar-preview-user', 'light');
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
  const root = {
    agent_id: ROOT,
    title: 'Launch a product',
    goal: 'Launch a product',
    model: 'rose-1-flash',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 0,
    status: 'ACTIVE',
    temporal_workflow_id: 'fixture-workflow',
    created_at: now,
    updated_at: now,
    parent_agent_id: null,
    tools: [],
    context_size: 0,
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    message_count: 1,
    price_limit_cents: 100,
    tree_cost_cents: 0,
  };
  const node = (id: string, parent: string, goal: string, status = 'ACTIVE') => ({
    agent_id: id,
    parent_agent_id: parent,
    goal,
    status,
    progress: 0,
    tools_in_use: [],
    message_count: 1,
    tree_cost_cents: 0,
  });
  const code = (id: string, owner: string, title: string) => ({
    code_agent_id: id,
    owner_agent_id: owner,
    root_agent_id: ROOT,
    provider: 'codex',
    title,
    status: 'ACTIVE',
    created_at: now,
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    let body: unknown = {};
    if (path === '/api/agents') body = { agents: [root] };
    else if (path === `/api/agents/${ROOT}`)
      body = {
        agent: root,
        pagination: { has_more: false, oldest_timestamp: null },
        messages: [
          { message_id: 'goal', timestamp: now, role: 'USER', text: 'Help me launch a product.' },
        ],
      };
    else if (path === '/api/agents/tree')
      body = {
        agents: [
          node(ROOT, '', root.goal),
          node('research', ROOT, 'Research audience'),
          node('competitors', 'research', 'Compare competitors'),
          node('done', ROOT, 'Review references', 'COMPLETED'),
        ],
      };
    else if (path === '/api/agents/code-agents')
      body = {
        code_agents: [
          code('landing', 'research', 'Build landing page'),
          code('build', ROOT, 'Check build'),
        ],
      };
    else if (path === '/api/projects') body = { projects: [] };
    else if (path === '/api/attention-requests') body = { requests: [] };
    else if (path === '/api/invite-codes/check') body = { needsInviteCode: false };
    await route.fulfill({ json: body });
  });
  await page.goto(`${FRONTEND_URL}/?agent-id=${ROOT}`, { waitUntil: 'domcontentloaded' });
}

test('sidebar opens direct children only and badges active tree agents on the minimized robot', async ({
  page,
}) => {
  await openSidebarPreview(page, 1280);
  const sidebar = page.getByTestId('rose-sidebar');
  const badge = page.getByTestId(`rose-agent-count-${ROOT}`);
  await expect(badge).toHaveText('5', { timeout: 60000 });
  await expect(sidebar).toHaveAttribute('data-expanded', 'false');
  const color = await badge.evaluate((el) => ({
    badge: getComputedStyle(el).color,
    robot: getComputedStyle(el.parentElement!.querySelector('svg')!).color,
  }));
  expect(color.badge).toBe(color.robot);
  await expect(page.getByTestId('rose-agent-row-research')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/rose-sidebar-minimized.png' });
  await page.mouse.move(800, 400);
  await sidebar.hover();
  await expect(sidebar).toHaveAttribute('data-expanded', 'true');
  await sidebar.getByRole('button', { name: 'Expand Launch a product', exact: true }).click();
  await expect(page.getByTestId('rose-agent-row-research')).toBeVisible();
  await expect(page.getByTestId('rose-agent-row-competitors')).toHaveCount(0);
  await expect(page.getByTestId('rose-code-agent-row-landing')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/rose-sidebar-first-layer.png' });
  await sidebar.getByRole('button', { name: 'Expand Research audience', exact: true }).click();
  await expect(page.getByTestId('rose-agent-row-competitors')).toBeVisible();
  await expect(page.getByTestId('rose-code-agent-row-landing')).toBeVisible();
  await page.screenshot({ path: '/tmp/rose-sidebar-expanded.png' });
  await sidebar.getByRole('button', { name: 'Collapse Launch a product', exact: true }).click();
  await sidebar.getByRole('button', { name: 'Expand Launch a product', exact: true }).click();
  await expect(page.getByTestId('rose-agent-row-competitors')).toHaveCount(0);
  await expect(
    sidebar.getByRole('button', { name: 'Expand Research audience', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
});

for (const width of [320, 390, 700]) {
  test(`mobile drawer fills all ${width}px of the viewport`, async ({ page }) => {
    await openSidebarPreview(page, width);
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Menu', exact: true });
    await expect(drawer).toBeVisible();
    await expect(async () => {
      const rect = await drawer.boundingBox();
      expect(rect).not.toBeNull();
      expect(Math.abs(rect!.x)).toBeLessThan(1);
      expect(Math.abs(rect!.width - width)).toBeLessThan(1);
    }).toPass();
    if (width === 390) await page.screenshot({ path: '/tmp/rose-mobile-drawer-full-width.png' });
    await drawer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(drawer).not.toBeVisible();
  });
}

test('authenticated app smoothly enters dark mode and manual light toggle still works', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (
        document.documentElement?.classList.contains('rose-login-theme-transition') &&
        document.body
      )
        (window as unknown as { loginThemeDuration: string }).loginThemeDuration = getComputedStyle(
          document.body,
        ).transitionDuration;
    });
    observer.observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  await openSidebarPreview(page, 390);
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { loginThemeDuration: string }).loginThemeDuration),
    )
    .toBe('0.4s');
  await expect(page.locator('html')).not.toHaveClass(/rose-login-theme-transition/);
  await page.getByRole('button', { name: 'Light mode', exact: true }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toBeVisible();
});
