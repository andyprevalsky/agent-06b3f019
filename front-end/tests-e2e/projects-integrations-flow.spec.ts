/**
 * Repositories live in Integrations; the left bar only has folders (plan
 * docs/plans/active/projects-are-repos.md, P1/P2/P7), in the real desktop and
 * mobile app. Controlled API only (every /api/** route is answered here).
 *
 *   - left bar: folders (isFolder rows) with plain folder icons and no settings;
 *     a repository that is not a folder is not listed there
 *   - Integrations › GitHub Repositories lists GitHub and imported repositories
 *     (not plain folders)
 *   - Import from your computer (the Mac app's import bridge scripted like
 *     `rose import detect|scan|apply`): folder picker → local agent reads it with
 *     an unbound code (POST {} mint) → plan review → Import → "<name> is ready";
 *     nothing to copy or paste
 *   - GitHub repo › Connect POSTs { repo_url } only and lists the new project
 *   - ⚙ opens project settings in place; Save PUTs only the edited field
 */
import { expect, test, type Page } from '@playwright/test';
import { FRONTEND_URL } from './helpers';
import type { MaintenanceState, Project } from '../src/lib/api/projects';

const LOGIN_CODE = `rlc_${'e'.repeat(32)}`;

function project(overrides: Partial<Project>): Project {
  const now = new Date().toISOString();
  return {
    id: 'p-rose',
    folders: [],
    name: 'Rose',
    repoUrl: 'https://github.com/Rose-Ai-Labs/rose',
    githubConnected: true,
    defaultBranch: 'main',
    startupScript: 'npm ci',
    startupTimeoutS: 120,
    lifecycle: { autoWake: true },
    sync: { revision: 4, lastSyncedAt: now },
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
    envFileCount: 6,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function signIn(page: Page) {
  // The Rose Mac app's import bridge only (no isElectron: the rest stays web),
  // answering like the app running `rose import detect|scan|apply`.
  await page.addInitScript(() => {
    type Listener = (event: unknown) => void;
    const listeners = new Set<Listener>();
    const requests: unknown[] = [];
    let runs = 0;
    const emit = (event: unknown) => listeners.forEach((listener) => listener(event));
    const plan = {
      projectName: 'acme-api',
      branch: 'main',
      repo: { remoteUrl: 'https://github.com/acme/acme-api', githubRepo: 'acme/acme-api' },
      envFiles: [{ path: '.env', variables: ['DATABASE_URL', 'STRIPE_SECRET_KEY'] }],
      extraFiles: [],
      setupCommands: ['npm ci'],
      notes: [],
      github: { status: 'unreachable', login: null, canImport: true },
    };
    (window as unknown as { __importRequests: unknown[] }).__importRequests = requests;
    (window as unknown as { api: unknown }).api = {
      roseCli: {
        pickProjectFolder: () =>
          Promise.resolve({ canceled: false, path: '/Users/andy/code/acme-api' }),
        importProject: (request: { action: string; agent?: string }) => {
          requests.push(request);
          runs += 1;
          const runId = `run-${runs}`;
          setTimeout(() => {
            if (request.action === 'detect')
              emit({
                runId,
                agents: [{ id: 'codex', signedIn: true, binary: '/bin/codex' }],
                preferred: 'codex',
              });
            else if (request.action === 'scan') {
              emit({ runId, event: 'progress', stage: 'scan', message: 'Reading package.json' });
              setTimeout(() => emit({ runId, event: 'plan', agent: request.agent, plan }), 300);
            } else emit({ runId, event: 'done', project: { id: 'p-acme', name: 'acme-api' } });
            setTimeout(() => emit({ runId, event: 'exit', code: 0 }), 400);
          }, 50);
          return Promise.resolve({ runId });
        },
        onImportEvent: (listener: Listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        cancelImport: () => Promise.resolve(),
      },
    };
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    const user = { id: 'projects-flow-viewer', is_anonymous: false };
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
}

for (const width of [1280, 390]) {
  test(`projects flow at ${width}px`, async ({ page }) => {
    test.setTimeout(60000);
    page.setDefaultTimeout(15000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const now = new Date().toISOString();
    const projects: Project[] = [
      // A legacy folder that also carries a repository: in both places.
      project({ isFolder: true, isRepository: true }),
      project({
        id: 'p-notes',
        name: 'pricing-notebooks',
        repoUrl: null,
        githubConnected: false,
        envFileCount: 2,
        isFolder: false,
        isRepository: true,
      }),
      project({
        id: 'p-web',
        name: 'Website',
        repoUrl: null,
        githubConnected: false,
        envFileCount: 0,
        sync: { revision: 0, lastSyncedAt: null },
        isFolder: true,
        isRepository: false,
      }),
    ];
    const writes: { method: string; path: string; body: unknown }[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const base = {
      status: 'COMPLETED',
      source: 'WEB',
      model: 'rose-1-flash',
      reasoning_effort: 'medium',
      created_at: now,
      updated_at: now,
      parent_agent_id: null,
      folder_id: null,
      tools: [],
      context_size: 0,
      token_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      message_count: 0,
      price_limit_cents: 100,
      tree_cost_cents: 0,
      progress: 1,
      tools_in_use: [],
    };
    const agents = [
      {
        ...base,
        agent_id: 'rose-agent',
        title: 'Rose work',
        goal: 'Rose work',
        project_id: 'p-rose',
      },
      { ...base, agent_id: 'home-agent', title: 'Dinner', goal: 'Dinner', project_id: null },
    ];
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      const method = request.method();
      if (method !== 'GET') writes.push({ method, path, body: request.postDataJSON() });
      let body: unknown = {};
      if (path === '/api/projects') body = { projects };
      else if (path === '/api/projects/cli-login-codes')
        return route.fulfill({
          status: 201,
          json: {
            code: LOGIN_CODE,
            expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
            project: null,
          },
        });
      else if (path === '/api/integrations/github/repos' && method === 'POST') {
        projects.push(
          project({ id: 'p-site', name: 'website', repoUrl: 'https://github.com/acme/website' }),
        );
        return route.fulfill({
          status: 201,
          json: {
            canonical_ref: 'gh:acme/website',
            repo_name: 'website',
            repo_url: 'https://github.com/acme/website',
            owner: 'acme',
            default_branch: 'main',
            connected_rose_project_ref: 'p-site',
            integration_id: 'gh',
            source: 'connect',
            connected_at: now,
          },
        });
      } else if (path === '/api/projects/p-rose' && method === 'PUT') {
        Object.assign(projects[0], request.postDataJSON());
        body = projects[0];
      } else if (path === '/api/projects/p-rose/maintenance')
        body = {
          snapshot: null,
          running: false,
          nextRunAt: null,
          watchCheckedAt: null,
          runs: [],
        } satisfies MaintenanceState;
      else if (path.endsWith('/env-files')) body = { envFiles: [], query: null };
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
      else if (path === '/api/teams') body = { teams: [], invitations: [] };
      else if (path === '/api/agents' || path === '/api/agents/tree') body = { agents };
      else if (path === '/api/agents/code-agents') body = { code_agents: [] };
      else if (path === '/api/attention-requests') body = { requests: [] };
      else if (path === '/api/invite-codes/check') body = { needsInviteCode: false };
      else if (method !== 'GET') return route.fulfill({ status: 204 });
      await route.fulfill({ json: body });
    });
    await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });

    // Left bar: folders only, no project settings.
    let list;
    if (width < 768) {
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      list = page.getByTestId('rose-mobile-agent-list');
    } else {
      const rail = page.getByTestId('rose-sidebar');
      await rail.waitFor();
      await page.mouse.move(500, 300);
      await rail.hover({ position: { x: 30, y: 100 } });
      await expect(rail).toHaveAttribute('data-expanded', 'true');
      list = rail;
    }
    await expect(list.getByRole('button', { name: '+ New folder', exact: true })).toBeVisible();
    const roseFolder = list.getByTestId('rose-project-row-p-rose');
    await expect(roseFolder).toBeVisible();
    await expect(list.getByTestId('rose-project-row-p-web')).toBeVisible();
    // A repository imported from the computer is not a folder.
    await expect(list.getByTestId('rose-project-row-p-notes')).toHaveCount(0);
    await expect(list.getByRole('button', { name: /folder settings/i })).toHaveCount(0);
    // Plain folder icon, no repository avatar.
    await expect(roseFolder.locator('img')).toHaveCount(0);
    await expect(list.getByText('Rose work', { exact: true })).toBeVisible();
    await expect(list.getByText('Dinner', { exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/rose-folders-left-bar-${width}.png` });
    if (width < 768) {
      await page
        .getByRole('dialog', { name: 'Menu' })
        .getByRole('button', { name: 'Close' })
        .click();
      await expect(page.getByRole('dialog', { name: 'Menu' })).toHaveCount(0);
    } else await page.mouse.move(700, 400);

    // Integrations › GitHub Repositories (desktop corner icon; same icon in the mobile header).
    await page.getByTestId('rose-app-integrations').filter({ visible: true }).click();
    const section = page.getByTestId('integrations-projects').filter({ visible: true });
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByTestId('project-row-p-rose')).toContainText(
      'Rose-Ai-Labs/rose · main · 6 env files',
    );
    await expect(section.getByTestId('project-row-p-notes')).toContainText('From your computer');
    // A plain folder is not a repository.
    await expect(section.getByTestId('project-row-p-web')).toHaveCount(0);
    await expect(section.getByRole('combobox')).toHaveCount(0);

    await section.getByRole('button', { name: 'Import from your computer' }).click();
    const review = section.getByTestId('local-import-review');
    await expect(review).toContainText('Codex read acme-api. Check what Rose will import:');
    await expect(review).toContainText('.env · DATABASE_URL, STRIPE_SECRET_KEY');
    await expect(review).toContainText('code agents will use your GitHub login on this Mac');
    await expect(review.getByRole('checkbox')).toHaveCount(0);
    expect(writes.find((w) => w.path === '/api/projects/cli-login-codes')?.body).toEqual({});
    await page.screenshot({ path: `/tmp/rose-projects-import-${width}.png` });
    await review.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(section.getByText('acme-api is ready')).toBeVisible();
    const importRequests = await page.evaluate(
      () =>
        (
          window as unknown as {
            __importRequests: { action: string; loginCode?: string; githubImport?: boolean }[];
          }
        ).__importRequests,
    );
    expect(importRequests.map((r) => r.action)).toEqual(['detect', 'scan', 'apply']);
    expect(importRequests[1].loginCode).toBe(LOGIN_CODE);
    expect(importRequests[2].githubImport).toBe(true);

    await section.getByRole('button', { name: 'Connect GitHub repo' }).click();
    await section
      .getByRole('textbox', { name: 'GitHub repository URL' })
      .fill('https://github.com/acme/website');
    await section.getByRole('button', { name: 'Connect repository' }).click();
    await expect(section.getByTestId('project-row-p-site')).toContainText('acme/website');
    expect(writes.find((w) => w.path === '/api/integrations/github/repos')?.body).toEqual({
      repo_url: 'https://github.com/acme/website',
    });

    await section.getByRole('button', { name: 'Rose settings' }).click();
    const settings = section.getByTestId('project-settings-content');
    await expect(settings.getByTestId('project-repository')).toHaveText(
      'https://github.com/Rose-Ai-Labs/rose',
    );
    await settings.getByRole('textbox', { name: 'Default branch' }).fill('develop');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(() => writes.filter((w) => w.path === '/api/projects/p-rose').map((w) => w.body))
      .toEqual([{ defaultBranch: 'develop' }]);
    await page.screenshot({ path: `/tmp/rose-projects-settings-${width}.png` });

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });
}
