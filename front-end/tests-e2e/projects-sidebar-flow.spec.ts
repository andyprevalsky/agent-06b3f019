/** Existing project rows/settings in the real desktop and mobile sidebar. Controlled API only. */
import { expect, test } from '@playwright/test';
import { FRONTEND_URL } from './helpers';
import type { GithubRepo } from '../src/features/integrations/api/githubRepos';
import type { Folder } from '../src/lib/api/folders';
import type { MaintenanceState, Project } from '../src/lib/api/projects';

/** GET /api/folders shape of a project row (mirrors rose-sidebar.fixtures `folderOf`). */
function folderOf(p: Project): Folder {
  const repo = /github\.com\/([^/]+)\/([^/.]+)/i.exec(p.repoUrl ?? '');
  return {
    id: p.id,
    name: p.name,
    legacy_project_id: p.id,
    subfolders: (p.folders ?? []).map((f) => ({ id: f.id, name: f.name })),
    github_repo:
      repo !== null && p.repoUrl !== null
        ? { canonical_ref: `gh:${repo[1]}/${repo[2]}`.toLowerCase(), repo_url: p.repoUrl }
        : null,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

/** GET /api/integrations/github/repos: each folder's connected repo, auto-imported. */
function connectedReposOf(projects: Project[]): GithubRepo[] {
  return projects.flatMap((p) => {
    const repo = folderOf(p).github_repo;
    if (repo === null) return [];
    const [owner, name] = repo.canonical_ref.slice('gh:'.length).split('/');
    return [
      {
        ...repo,
        repo_name: name,
        owner,
        default_branch: p.defaultBranch,
        connected_rose_project_ref: p.id,
        integration_id: 'github-integration',
        source: 'legacy_project',
        connected_at: p.createdAt,
      },
    ];
  });
}
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
      if (path === '/api/folders') {
        // Folders are the project rows (GET /api/folders shape: rose-sidebar.fixtures folderOf).
        if (request.method() === 'POST') {
          const input = request.postDataJSON();
          writes.push(input);
          const created: Project = {
            ...project,
            id: 'created',
            name: input.name,
            folders: [],
            repoUrl: null,
            githubConnected: false,
          };
          projects = [...projects, created];
          return route.fulfill({ json: folderOf(created), status: 201 });
        }
        body = { folders: projects.map(folderOf) };
      } else if (path === '/api/projects') body = { projects };
      else if (path === '/api/integrations/github/repos')
        body = { repos: connectedReposOf(projects) };
      // The rest of the Integrations panel the folder settings link opens: nothing connected.
      else if (path === '/api/integrations') body = { integrations: [] };
      else if (path === '/api/integrations/plaid/items') body = { items: [] };
      else if (path === '/api/compute-accounts') body = { accounts: [] };
      else if (path === '/api/integrations/granola')
        body = {
          connected: false,
          status: 'NOT_CONNECTED',
          accountEmail: null,
          backfillDone: false,
          lastSuccessfulSyncAt: null,
          lastError: null,
          documents: {},
        };
      else if (path === '/api/iphone/connection')
        body = {
          enabled: false,
          configured: false,
          status: 'not_connected',
          setupAgentId: null,
          connectionRevision: 0,
        };
      else if (path === '/api/projects/p-rose/folders' && request.method() === 'POST') {
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

    await folderRow.getByRole('button', { name: 'Collapse subfolder Interface' }).click();
    await expect(folderRow.getByText('Rose work', { exact: true })).toHaveCount(0);
    await folderRow.getByRole('button', { name: 'Expand subfolder Interface' }).click();
    await row.getByRole('button', { name: 'New subfolder in Rose' }).click();
    const folderName = page.getByRole('textbox', { name: 'New subfolder name' });
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
    await row.getByRole('button', { name: 'Rose folder settings' }).click();
    const settings =
      width < 768
        ? page.getByTestId('project-settings-content')
        : page.getByTestId('rose-project-settings');
    await expect(settings.getByRole('button', { name: 'Download setup helper' })).toHaveCount(0);
    await expect(
      settings.getByRole('spinbutton', { name: 'Startup timeout (seconds)' }),
    ).toHaveValue('120');
    // The folder's repo is read-only here (GET /api/folders); the Integrations panel changes it.
    const repo = settings.getByRole('region', { name: 'GitHub repo' });
    await expect(repo.getByTestId('folder-github-repo')).toHaveText('gh:rose-ai-labs/rose');
    await expect(settings.getByRole('textbox', { name: 'Repository URL' })).toHaveCount(0);
    await expect(settings.getByRole('button', { name: 'Change', exact: true })).toHaveCount(0);
    await settings.getByRole('textbox', { name: 'Default branch' }).fill('develop');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => writes).toContainEqual({ defaultBranch: 'develop' });
    await expect(settings.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    const switchInIntegrations = repo.getByRole('button', { name: 'Switch repo in Integrations' });
    await expect(switchInIntegrations).toBeVisible();
    // The link opens the Integrations panel at its GitHub section with this folder pre-selected.
    // On mobile it also closes the agents sheet that holds these settings, so the panel is in view.
    await switchInIntegrations.click();
    const switchRepo = page.getByRole('form', { name: "Switch a folder's repo" });
    await expect(switchRepo).toBeVisible();
    await expect(switchRepo.getByRole('combobox', { name: 'Folder to switch' })).toHaveValue(
      'p-rose',
    );
    await expect(switchRepo.getByTestId('switch-current-repo')).toContainText(
      'Rose uses gh:rose-ai-labs/rose',
    );
    if (width >= 768) {
      const integrations = page.getByTestId('rose-app-integrations');
      await expect(integrations).toHaveAttribute('aria-pressed', 'true');
      // No close X on desktop panels: the pressed icon closes it.
      await integrations.click();
      await expect(integrations).toHaveAttribute('aria-pressed', 'false');
      await expect(switchRepo).toHaveCount(0);
      await settings.getByRole('button', { name: 'Close folder settings' }).click();
    } else {
      await expect(page.getByTestId('rose-mobile-agent-list')).toBeHidden();
      // The full-screen mobile sheet keeps its own close X.
      await page.getByRole('button', { name: 'Close integrations' }).click();
      await expect(switchRepo).toHaveCount(0);
      // Reopening the menu lands on the agents list, not the closed settings.
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      await expect(row).toBeVisible();
      await expect(page.getByTestId('project-settings-content')).toHaveCount(0);
    }
    if (width >= 768) {
      await page.mouse.move(500, 300);
      await page.getByTestId('rose-sidebar').hover({ position: { x: 30, y: 100 } });
    }
    const create = page
      .getByRole('button', { name: '+ New folder', exact: true })
      .filter({ visible: true });
    await create.click();
    const input = page.getByRole('textbox', { name: 'New folder name' });
    await input.fill('Cancelled');
    await input.press('Escape');
    await expect(input).toHaveCount(0);
    if (width < 768) await expect(page.getByRole('dialog')).toBeVisible();
    await create.click();
    await input.fill('Website');
    await input.press('Enter');
    await expect.poll(() => writes).toContainEqual({ name: 'Website' });
    await expect(
      page.getByTestId('rose-project-row-created').filter({ visible: true }),
    ).toBeVisible();
    if (width >= 768) await page.getByTestId('rose-sidebar').hover({ position: { x: 30, y: 100 } });
    // A held press (like a person's), so the menu's pre-measure position cannot swallow the release.
    await row.click({ button: 'right', delay: 120 });
    const menu = page.getByTestId('rose-project-menu');
    await expect(menu.getByRole('menuitem', { name: 'Rename folder' })).toBeVisible();
    const hit = await menu.boundingBox();
    expect(
      await page.evaluate(
        ({ x, y }) =>
          Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="rose-project-menu"]')),
        { x: hit!.x + 20, y: hit!.y + 15 },
      ),
    ).toBe(true);
    await menu.getByRole('menuitem', { name: 'Delete folder' }).click();
    const confirmation = page.getByRole(width < 768 ? 'alertdialog' : 'dialog', {
      name: 'Delete folder “Rose”?',
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
