/** Existing project rows/settings in the real desktop and mobile sidebar. Controlled API only. */
import { expect, test } from '@playwright/test';
import { FRONTEND_URL } from './helpers';
import type { MaintenanceState, Project } from '../src/lib/api/projects';
for (const width of [1280, 390]) {
  test(`original project flow at ${width}px`, async ({ page }) => {
    test.setTimeout(60000);
    page.setDefaultTimeout(15000);
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
      const user = { id: 'project-flow-viewer', is_anonymous: false };
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
    let project: Project = {
      id: 'p-rose',
      folders: [{ id: 'f-ui', name: 'Interface', projectId: 'p-rose' }],
      name: 'Rose',
      repoUrl: 'https://github.com/Rose-Ai-Labs/rose',
      githubConnected: true,
      defaultBranch: 'main',
      startupScript: 'npm ci',
      startupTimeoutS: 120,
      lifecycle: { autoWake: true },
      sync: { revision: 0, lastSyncedAt: null },
      maintenance: {
        script: null,
        timeoutS: 480,
        nightly: false,
        onGithubChange: false,
        nextRunAt: null,
        watchCheckedAt: null,
        running: false,
      },
      snapshot: null,
      envFileCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    let projects = [project];
    const writes: unknown[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const agent = {
      agent_id: 'project-agent',
      title: 'Rose work',
      goal: 'Rose work',
      project_id: 'p-rose',
      folder_id: 'f-ui',
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
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      let body: unknown = {};
      if (path === '/api/projects') {
        if (request.method() === 'POST') {
          const input = request.postDataJSON();
          writes.push(input);
          const created = { ...project, id: 'created', name: input.name };
          projects = [...projects, created];
          return route.fulfill({ json: created, status: 201 });
        }
        body = { projects };
      } else if (path === '/api/projects/p-rose/folders' && request.method() === 'POST') {
        const folder = { id: 'f-new', name: request.postDataJSON().name, projectId: 'p-rose' };
        project = { ...project, folders: [...project.folders, folder] };
        projects = projects.map((p) => (p.id === project.id ? project : p));
        return route.fulfill({ json: folder, status: 201 });
      } else if (path === '/api/projects/p-rose' && request.method() === 'PUT') {
        const input = request.postDataJSON();
        writes.push(input);
        project = { ...project, ...input };
        projects = projects.map((p) => (p.id === project.id ? project : p));
        body = project;
      } else if (path === '/api/projects/p-rose/maintenance') {
        body = {
          snapshot: project.snapshot,
          running: project.maintenance.running,
          nextRunAt: project.maintenance.nextRunAt,
          watchCheckedAt: project.maintenance.watchCheckedAt,
          runs: [],
        } satisfies MaintenanceState;
      } else if (path.endsWith('/env-files')) body = { envFiles: [] };
      else if (path === '/api/agents') body = { agents: [agent] };
      else if (path === '/api/agents/code-agents') body = { code_agents: [] };
      else if (path === '/api/agents/tree')
        body = {
          agents: [
            { ...agent, progress: 1, tools_in_use: [] },
            {
              ...agent,
              agent_id: 'navigation-child',
              parent_agent_id: agent.agent_id,
              title: null,
              goal: 'Audit navigation',
              progress: 1,
              tools_in_use: [],
            },
          ],
        };
      else if (path === '/api/attention-requests') body = { requests: [] };
      else if (path === '/api/invite-codes/check') body = { needsInviteCode: false };
      else if (request.method() !== 'GET') return route.fulfill({ status: 204 });
      await route.fulfill({ json: body });
    });
    await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    if (width < 768) await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    else {
      const rail = page.getByTestId('rose-sidebar');
      await rail.waitFor();
      await page.mouse.move(500, 300);
      await rail.hover({ position: { x: 30, y: 100 } });
      await expect(rail).toHaveAttribute('data-expanded', 'true');
    }
    const row = page.getByTestId('rose-project-row-p-rose').filter({ visible: true });
    await expect(row).toBeVisible();
    const folderRow = page.getByTestId('rose-folder-f-ui').filter({ visible: true });
    await expect(folderRow.getByText('Rose work', { exact: true })).toBeVisible();
    await folderRow.getByRole('button', { name: 'Expand Rose work', exact: true }).click();
    const children = folderRow.getByTestId('rose-agent-children-project-agent');
    const finished = children.getByRole('button', { name: 'Finished agents (1)', exact: true });
    await expect(finished).toHaveAttribute('aria-expanded', 'false');
    await finished.click();
    await expect(folderRow.getByText('Audit navigation', { exact: true })).toBeVisible();
    await expect(folderRow.getByTestId('rose-agent-children-project-agent')).toContainText(
      'Audit navigation',
    );
    await page.screenshot({
      path: `/tmp/rose-folder-subagent-${width}.png`,
      clip: { x: 0, y: 0, width: width < 768 ? 390 : 235, height: width < 768 ? 510 : 370 },
    });

    await folderRow.getByRole('button', { name: 'Collapse folder Interface' }).click();
    await expect(folderRow.getByText('Rose work', { exact: true })).toHaveCount(0);
    await folderRow.getByRole('button', { name: 'Expand folder Interface' }).click();
    await row.getByRole('button', { name: 'New folder in Rose' }).click();
    const folderName = page.getByRole('textbox', { name: 'New folder name' });
    await folderName.fill('Research');
    await folderName.press('Enter');
    await expect(page.getByTestId('rose-folder-f-new').filter({ visible: true })).toHaveText(
      /Research/,
    );
    await page.screenshot({ path: `/tmp/rose-project-folders-${width}.png` });
    await folderRow.getByRole('button', { name: 'Create Super Agent in Interface' }).click();
    await expect(page.getByTestId('new-agent-location')).toHaveText(
      'New agent in Rose / Interface',
    );
    if (width < 768) await expect(page.getByRole('dialog')).toHaveCount(0);
    if (width < 768) await expect(page.getByTestId('new-agent-location')).toBeHidden();
    else await expect(page.getByTestId('new-agent-location')).toBeVisible();
    await page.screenshot({ path: `/tmp/rose-folder-target-${width}.png` });
    if (width < 768) await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    else await page.getByTestId('rose-sidebar').hover({ position: { x: 30, y: 100 } });
    await row.getByRole('button', { name: 'Create Super Agent', exact: true }).click();
    await expect(page.getByTestId('new-agent-location')).toHaveText('New agent in Rose');
    if (width < 768) await expect(page.getByTestId('new-agent-location')).toBeHidden();
    else await expect(page.getByTestId('new-agent-location')).toBeVisible();
    if (width < 768) await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    else await page.getByTestId('rose-sidebar').hover({ position: { x: 30, y: 100 } });
    await expect(page.getByRole('button', { name: 'Projects', exact: true })).toHaveCount(0);
    await row.getByRole('button', { name: 'Rose project settings' }).click();
    const settings =
      width < 768
        ? page.getByTestId('project-settings-content')
        : page.getByTestId('rose-project-settings');
    await expect(settings.getByRole('button', { name: 'Download setup helper' })).toHaveCount(0);
    await expect(
      settings.getByRole('spinbutton', { name: 'Startup timeout (seconds)' }),
    ).toHaveValue('120');
    await settings.getByRole('button', { name: 'Change', exact: true }).click();
    await settings
      .getByRole('textbox', { name: 'Repository URL' })
      .fill('https://github.com/example/updated');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(() => writes)
      .toContainEqual({ repoUrl: 'https://github.com/example/updated' });
    await expect(settings.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    if (width < 768) await page.getByRole('button', { name: 'Back to agents' }).click();
    else await settings.getByRole('button', { name: 'Close project settings' }).click();
    if (width >= 768) {
      await page.mouse.move(500, 300);
      await page.getByTestId('rose-sidebar').hover({ position: { x: 30, y: 100 } });
    }
    const create = page
      .getByRole('button', { name: '+ New project', exact: true })
      .filter({ visible: true });
    await create.click();
    const input = page.getByRole('textbox', { name: 'New project name' });
    await input.fill('Cancelled');
    await input.press('Escape');
    await expect(input).toHaveCount(0);
    if (width < 768) await expect(page.getByRole('dialog')).toBeVisible();
    await create.click();
    await input.fill('Website');
    await input.press('Enter');
    await expect(
      page.getByTestId('rose-project-row-created').filter({ visible: true }),
    ).toBeVisible();
    if (width >= 768) await page.getByTestId('rose-sidebar').hover({ position: { x: 30, y: 100 } });
    // A held press (like a person's), so the menu's pre-measure position cannot swallow the release.
    await row.click({ button: 'right', delay: 120 });
    const menu = page.getByTestId('rose-project-menu');
    await expect(menu.getByRole('menuitem', { name: 'Rename project' })).toBeVisible();
    const hit = await menu.boundingBox();
    expect(
      await page.evaluate(
        ({ x, y }) =>
          Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="rose-project-menu"]')),
        { x: hit!.x + 20, y: hit!.y + 15 },
      ),
    ).toBe(true);
    await menu.getByRole('menuitem', { name: 'Delete project' }).click();
    const confirmation = page.getByRole(width < 768 ? 'alertdialog' : 'dialog', {
      name: 'Delete project “Rose”?',
    });
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    if (width >= 768) {
      await page.mouse.move(500, 300);
      await page.getByTestId('rose-sidebar').hover({ position: { x: 30, y: 100 } });
    }
    await expect(row).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });
}
