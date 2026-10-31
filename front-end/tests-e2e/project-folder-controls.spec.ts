import { expect, test } from '@playwright/test';
import { FRONTEND_URL } from './helpers';

for (const width of [1280, 390]) {
  test(`folder ordering, icon counts and project collapse at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
      const user = { id: 'folder-controls-viewer', is_anonymous: false };
      localStorage.setItem('app-user', JSON.stringify(user));
      localStorage.setItem(
        'rose-session',
        JSON.stringify({
          user,
          access_token: 'fixture',
          refresh_token: 'fixture',
          token_type: 'bearer',
          expires_at: 9999999999,
        }),
      );
    });
    const now = new Date().toISOString();
    let folders = [
      { id: 'single', name: 'Design', projectId: 'project', count: 9 },
      { id: 'double', name: 'Research', projectId: 'project', count: 42 },
      { id: 'triple', name: 'Engineering', projectId: 'project', count: 128 },
    ];
    const project = {
      id: 'project',
      name: 'Workspace',
      repoUrl: null,
      githubConnected: false,
      defaultBranch: 'main',
      startupScript: null,
      startupTimeoutS: 120,
      lifecycle: { autoWake: true },
      sync: { revision: 0, lastSyncedAt: null },
      envFileCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const baseAgent = {
      status: 'COMPLETED',
      source: 'WEB',
      model: 'rose-1-flash',
      reasoning_effort: 'medium',
      created_at: now,
      updated_at: now,
      parent_agent_id: null,
      tools: [],
      context_size: 0,
      token_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      message_count: 0,
      price_limit_cents: 100,
      tree_cost_cents: 0,
    };
    const agents = [
      ...folders.flatMap((folder) =>
        Array.from({ length: folder.count }, (_, index) => ({
          ...baseAgent,
          agent_id: `${folder.id}-${index}`,
          goal: `${folder.name} task ${index}`,
          project_id: project.id,
          folder_id: folder.id,
        })),
      ),
      { ...baseAgent, agent_id: 'home-task', goal: 'Home task', project_id: null, folder_id: null },
    ];
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      let body: unknown = {};
      if (path === '/api/projects') body = { projects: [{ ...project, folders }] };
      else if (
        path.match(/^\/api\/projects\/project\/folders\/[^/]+\/position$/) &&
        request.method() === 'PUT'
      ) {
        const { beforeId } = request.postDataJSON() as { beforeId: string | null };
        const folderId = path.split('/').at(-2)!;
        const moved = folders.find((folder) => folder.id === folderId)!;
        const next = folders.filter((folder) => folder.id !== folderId);
        next.splice(
          beforeId === null ? next.length : next.findIndex((folder) => folder.id === beforeId),
          0,
          moved,
        );
        folders = next;
        body = { folders };
      } else if (path === '/api/agents') body = { agents };
      else if (path === '/api/agents/code-agents') body = { code_agents: [] };
      else if (path === '/api/agents/tree') body = { agents: [] };
      else if (path === '/api/attention-requests') body = { requests: [] };
      else if (path === '/api/invite-codes/check') body = { needsInviteCode: false };
      else if (path.endsWith('/env-files')) body = { envFiles: [] };
      else if (request.method() !== 'GET') return route.fulfill({ status: 204 });
      await route.fulfill({ json: body });
    });
    const openSidebar = async () => {
      if (width < 768) await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      else {
        await page.mouse.move(500, 300);
        await page.getByTestId('rose-sidebar').hover({ position: { x: 30, y: 100 } });
      }
    };
    await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    await openSidebar();
    const group = page.getByTestId('rose-group-project').filter({ visible: true });
    for (const folder of folders) {
      const row = page.getByTestId(`rose-folder-${folder.id}`).filter({ visible: true });
      const icon = row.getByRole('img', { name: `${folder.count} agents`, exact: true });
      const badge = icon.getByTestId('folder-agent-count');
      await expect(badge).toHaveText(String(folder.count));
      const box = await icon.boundingBox();
      const countBox = await badge.boundingBox();
      expect(box).not.toBeNull();
      expect(countBox).not.toBeNull();
      expect(await badge.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
        'rgba(0, 0, 0, 0)',
      );
      expect(countBox!.x).toBeGreaterThanOrEqual(box!.x);
      expect(countBox!.x + countBox!.width).toBeLessThanOrEqual(box!.x + box!.width);
      expect(countBox!.y + countBox!.height).toBeLessThanOrEqual(box!.y + box!.height - 3);
      await row.getByRole('button', { name: `Collapse folder ${folder.name}` }).click();
    }
    if (width >= 768) await openSidebar();
    await page.screenshot({ path: `/tmp/rose-folder-counts-${width}.png` });
    await page
      .getByRole('button', { name: 'Collapse Workspace project' })
      .filter({ visible: true })
      .click();
    await expect(group).toHaveCount(0);
    await expect(page.getByTestId('rose-group-home').filter({ visible: true })).toBeVisible();
    await page
      .getByRole('button', { name: 'Collapse Home project' })
      .filter({ visible: true })
      .click();
    await expect(page.getByTestId('rose-group-home').filter({ visible: true })).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Expand Workspace project' })
      .filter({ visible: true })
      .click();
    if (width >= 768) await openSidebar();
    await page
      .getByRole('button', { name: 'Research folder options' })
      .filter({ visible: true })
      .click();
    await page.getByRole('menuitem', { name: 'Move up' }).click();
    const order = async () =>
      group
        .locator('[data-testid^="rose-folder-"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')));
    await expect
      .poll(order)
      .toEqual(['rose-folder-double', 'rose-folder-single', 'rose-folder-triple']);
    if (width >= 768) {
      await group
        .locator('[data-testid="rose-folder-triple"] [draggable="true"]')
        .dragTo(group.locator('[data-testid="rose-folder-double"] [draggable="true"]'), {
          targetPosition: { x: 75, y: 2 },
        });
      await expect
        .poll(order)
        .toEqual(['rose-folder-triple', 'rose-folder-double', 'rose-folder-single']);
    }
    const saved = await order();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openSidebar();
    await expect.poll(order).toEqual(saved);
    await expect(
      page.getByRole('button', { name: 'Expand Home project' }).filter({ visible: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Create Super Agent', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await expect(page.getByTestId('pending-project-frame')).toHaveCount(0);
    await expect(page.getByTestId('new-agent-location')).toHaveText('New agent in Workspace');
    if (width < 768) await expect(page.getByTestId('new-agent-location')).toBeHidden();
    else await expect(page.getByTestId('new-agent-location')).toBeVisible();
  });
}
