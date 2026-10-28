/** Actual sidebar screenshots with deterministic agent trees; no live agents. */
import { expect, test, type Page } from '@playwright/test';
import { FRONTEND_URL } from './helpers';
const ROOT = 'launch-root';
async function openSidebarPreview(page: Page, width: number) {
  await page.setViewportSize({ width, height: 820 });
  await page.addInitScript(() => {
    const user = { id: 'sidebar-preview-user', is_anonymous: false };
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
    robot: getComputedStyle(el.parentElement!.querySelector('[data-sidebar-agent-icon]')!).color,
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
  await expect(
    sidebar.getByTestId('rose-agent-row-launch-root').getByRole('progressbar'),
  ).toBeVisible();
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
    const header = page.getByTestId('rose-mobile-header');
    const back = header.getByRole('button', { name: 'Back', exact: true });
    const menu = header.getByRole('button', { name: 'Open menu', exact: true });
    const rose = header.getByRole('button', { name: 'Rose', exact: true });
    // The preview opens an agent: Back sits far left, the agents menu after it.
    const backRect = await back.boundingBox();
    const menuRect = await menu.boundingBox();
    expect(backRect!.x).toBeLessThan(10);
    expect(menuRect!.x).toBeGreaterThanOrEqual(backRect!.x + backRect!.width - 1);
    if (width >= 360) {
      const roseRect = await rose.boundingBox();
      expect(width - (roseRect!.x + roseRect!.width)).toBeLessThan(10);
    } else {
      // Below 360px the Rose icon (also "home") yields its slot to Back.
      await expect(rose).toBeHidden();
    }
    const controls = await header.getByRole('button').all();
    const boxes = (await Promise.all(controls.map((button) => button.boundingBox())))
      .filter((box): box is NonNullable<typeof box> => box !== null)
      .sort((a, b) => a.x - b.x);
    for (let i = 1; i < boxes.length; i++)
      expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width - 1);
    const last = boxes[boxes.length - 1];
    expect(last.x + last.width).toBeLessThanOrEqual(width + 1);
    await menu.click();
    const drawer = page.getByRole('dialog', { name: 'Menu', exact: true });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveClass(/slide-in-from-left/);
    await expect(async () => {
      const rect = await drawer.boundingBox();
      expect(rect).not.toBeNull();
      expect(Math.abs(rect!.x)).toBeLessThan(1);
      expect(Math.abs(rect!.width - width)).toBeLessThan(1);
    }).toPass();
    if (width === 390) {
      await page.screenshot({ path: '/tmp/rose-mobile-drawer-full-width.png' });
    }
    await drawer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(drawer).not.toBeVisible();
    if (width === 390) await page.screenshot({ path: '/tmp/rose-mobile-header-rose-right.png' });
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
  await expect(page.getByTestId('terminal-opening-loader')).toHaveCSS('opacity', '0.2');
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { loginThemeDuration: string }).loginThemeDuration),
    )
    .toBe('0.42s');
  await expect(page.locator('html')).not.toHaveClass(/rose-login-theme-transition/);
  await page.getByRole('button', { name: 'Light mode', exact: true }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toBeVisible();
  await expect(page.getByTestId('terminal-opening-loader')).toHaveCSS('opacity', '0.2');
});

test('mobile drawer survives repeated close, Escape, selection and rotation without trapping the app', async ({
  page,
}) => {
  await openSidebarPreview(page, 390);
  const menu = page.getByRole('button', { name: 'Open menu', exact: true });
  const drawer = page.getByRole('dialog', { name: 'Menu', exact: true });
  for (let i = 0; i < 3; i++) {
    await menu.click();
    await expect(drawer).toHaveCount(1);
    if (i === 0) await page.keyboard.press('Escape');
    else await drawer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(drawer).not.toBeVisible();
  }
  await menu.click();
  await drawer.getByTestId('rose-agent-row-launch-root').click();
  await expect(drawer).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp('agent-id=' + ROOT));
  await menu.click();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByTestId('rose-sidebar')).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await menu.click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rose', exact: true })).toBeVisible();
});

test('ordinary mobile account has no public-site links or popular goals', async ({ page }) => {
  await openSidebarPreview(page, 390);
  await page.getByRole('button', { name: 'Rose', exact: true }).click();
  const composer = page.getByPlaceholder('Enter any goal');
  await expect(composer).toBeVisible();
  for (const label of ['Research', 'Careers', 'About', 'Privacy', 'Terms'])
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  // Popular Goals were removed from Rose Desktop; the composer is the only goal entry.
  await expect(page.getByTestId('popular-goals-track')).toHaveCount(0);
  await composer.fill('Get Rose Api Key');
  await expect(composer).toHaveValue('Get Rose Api Key');
});

test('dark mobile agents use robots and retain one-layer disclosure', async ({ page }) => {
  await openSidebarPreview(page, 390);
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Menu', exact: true });
  const root = drawer.getByTestId('rose-agent-row-launch-root');
  await expect(root).toBeVisible();
  const contrast = await root.evaluate((el) => {
    const lum = (s: string) =>
      (s.match(/[\d.]+/g) ?? [])
        .slice(0, 3)
        .map(Number)
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
    let bg = 'rgb(255,255,255)';
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') {
        bg = c;
        break;
      }
    }
    const ratio = (c: string) =>
      (Math.max(lum(c), lum(bg)) + 0.05) / (Math.min(lum(c), lum(bg)) + 0.05);
    return {
      text: ratio(getComputedStyle(el).color),
      robot: ratio(getComputedStyle(el.querySelector('svg.lucide-bot')!).color),
    };
  });
  expect(contrast.text).toBeGreaterThanOrEqual(4.5);
  expect(contrast.robot).toBeGreaterThanOrEqual(3);
  await expect(root.locator('svg.lucide-bot')).toBeVisible();
  await expect(drawer.locator('[data-letter]')).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Expand Launch a product', exact: true }).click();
  await expect(drawer.getByTestId('rose-agent-row-research')).toBeVisible();
  await expect(drawer.getByTestId('rose-agent-row-competitors')).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Expand Research audience', exact: true }).click();
  await expect(drawer.getByTestId('rose-agent-row-competitors')).toBeVisible();
  await expect(
    drawer.getByTestId('rose-agent-row-research').locator('svg.lucide-bot'),
  ).toBeVisible();
  await expect(
    drawer.getByTestId('rose-agent-row-competitors').locator('svg.lucide-bot'),
  ).toBeVisible();
  await expect(drawer.locator('[data-letter]')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: /Build landing page/ })).toBeVisible();
  await page.screenshot({ path: '/tmp/rose-dark-mobile-agents.png' });
  await drawer.getByRole('button', { name: 'Collapse Launch a product', exact: true }).click();
  await expect(drawer.getByTestId('rose-agent-row-research')).toHaveCount(0);
});
for (const width of [320, 390, 1280]) {
  test(`model picker is flush bottom left at ${width}px`, async ({ page }) => {
    await openSidebarPreview(page, width);
    await page.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded' });
    const chip = page.getByTestId('query-model-selector').filter({ visible: true }).last();
    await expect(chip).toBeVisible();
    const m = await chip.evaluate((el) => {
      const shell = el.closest('[data-testid="query-input-surface"]')!;
      const s = shell.getBoundingClientRect(),
        c = el.getBoundingClientRect();
      const row = shell
          .querySelector('[data-testid="query-input-controls"]')!
          .getBoundingClientRect(),
        css = getComputedStyle(shell);
      // The paperclip sits immediately left of the model name (Andy, 2026-10-28):
      // it is the flush-left control and the model chip follows it.
      const clip = el.parentElement!.firstElementChild!.getBoundingClientRect();
      return {
        clipLeft: clip.left - s.left,
        clipToChip: c.left - clip.right,
        inset: parseFloat(css.paddingLeft) + parseFloat(css.borderLeftWidth),
        bottom: row.bottom - c.bottom,
        shellBottom: s.bottom - c.bottom,
        bottomInset: parseFloat(css.paddingBottom) + parseFloat(css.borderBottomWidth),
      };
    });
    expect(Math.abs(m.clipLeft - m.inset)).toBeLessThan(1);
    expect(m.clipToChip).toBeGreaterThanOrEqual(0);
    expect(m.clipToChip).toBeLessThan(9);
    expect(Math.abs(m.bottom)).toBeLessThan(1);
    expect(Math.abs(m.shellBottom - m.bottomInset)).toBeLessThan(1);
    await chip.click();
    await expect(page.getByRole('dialog').last()).toBeVisible();
    await page.keyboard.press('Escape');
    if (width === 390) await page.screenshot({ path: '/tmp/rose-model-bottom-left.png' });
  });
}

test('mobile composer is twenty percent shorter and preserves typing and safe area', async ({
  page,
}) => {
  await openSidebarPreview(page, 390);
  await page.goto(FRONTEND_URL, { waitUntil: 'domcontentloaded' });
  const box = page.getByTestId('query-input-surface').filter({ visible: true }).last();
  await expect(box).toBeVisible();
  const compact = (await box.boundingBox())!.height;
  const legacy = await page.addStyleTag({
    content:
      '.rose-mobile-query-area [data-surface] {padding-top:12px!important} .rose-mobile-query-area [data-surface] textarea {height:72px!important;min-height:56px!important;padding-top:12px!important;padding-bottom:12px!important}',
  });
  const original = (await box.boundingBox())!.height;
  await legacy.evaluate((el) => el.remove());
  expect(compact / original).toBeGreaterThan(0.78);
  expect(compact / original).toBeLessThan(0.82);
  console.log('Mobile composer height:', { original, compact, ratio: compact / original });
  await page.screenshot({ path: '/tmp/rose-mobile-compact-query.png' });
  const textarea = box.getByRole('textbox');
  await textarea.fill('A short goal');
  await expect(textarea).toHaveValue('A short goal');
  await textarea.press('Shift+Enter');
  await textarea.press('a');
  await expect(textarea).toHaveValue('A short goal\na');
  await page.addStyleTag({ content: ':root {--safe-area-inset-bottom:34px!important}' });
  expect(
    await box.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom)),
  ).toBeGreaterThanOrEqual(34 - 8 + 12);
});
