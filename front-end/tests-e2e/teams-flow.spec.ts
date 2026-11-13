/** Actual app/browser UI with an isolated in-memory API. No real emails or grants. */
import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FRONTEND_URL } from './helpers';
import type { Team, ShareableIntegration } from '../src/lib/api/teams';
import type { Project } from '../src/lib/api/projects';

const evidence = resolve(process.env.TEAMS_UI_EVIDENCE_DIR ?? '../.context/teams/evidence');

test.use({
  video: {
    mode: 'on',
    size: { width: Number(process.env.TEAMS_UI_VIDEO_WIDTH ?? 1280), height: 960 },
  },
});
const widths = process.env.TEAMS_UI_VIEWPORT
  ? [Number(process.env.TEAMS_UI_VIEWPORT)]
  : [1280, 390];
for (const width of widths) {
  test(`Teams create, invite, opt-in and revoke at ${width}px (API fixture)`, async ({ page }) => {
    test.setTimeout(90_000);
    page.setDefaultTimeout(15_000);
    await mkdir(evidence, { recursive: true });
    await page.setViewportSize({ width, height: 960 });
    const viewerId = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
    await page.addInitScript(
      ({ viewerId }) => {
        const user = {
          id: viewerId,
          is_anonymous: false,
          email: 'owner@example.test',
          user_metadata: { full_name: 'Fixture owner' },
        };
        localStorage.setItem('app-user', JSON.stringify(user));
        localStorage.setItem(`rose-theme:${viewerId}`, 'light');
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
      },
      { viewerId },
    );
    const now = new Date().toISOString();
    const teams: Team[] = [];
    const project: Project = {
      id: 'project-rose',
      name: 'Rose',
      repoUrl: null,
      githubConnected: false,
      defaultBranch: 'main',
      startupScript: null,
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
    const accounts: ShareableIntegration[] = [
      {
        id: 'work-mail',
        integrationId: 'gmail-parent',
        provider: 'gmail',
        accountId: 'owner@roselabs.ai',
        accountEmail: 'owner@roselabs.ai',
        name: 'gmail',
        status: 'CONNECTED',
        teamIds: [],
      },
      {
        id: 'private-mail',
        integrationId: 'gmail-parent',
        provider: 'gmail',
        accountId: 'private@example.test',
        accountEmail: 'private@example.test',
        name: 'gmail',
        status: 'CONNECTED',
        teamIds: [],
      },
      {
        id: 'messages',
        integrationId: 'messages',
        provider: 'imessage',
        accountId: '',
        accountEmail: null,
        name: 'iMessage',
        status: 'CONNECTED',
        teamIds: [],
      },
    ];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (!path.startsWith('/api/')) {
        if (url.origin !== new URL(FRONTEND_URL).origin) return route.abort();
        return route.continue();
      }
      let body: unknown = {};
      if (path === '/api/teams' && request.method() === 'POST') {
        const team: Team = {
          id: 'team-rose',
          name: request.postDataJSON().name,
          ownerUserId: viewerId,
          role: 'OWNER',
          status: 'ACCEPTED',
          createdAt: now,
          updatedAt: now,
          members: [
            {
              id: 'owner-member',
              userId: viewerId,
              name: 'Fixture owner',
              email: 'owner@example.test',
              role: 'OWNER',
              status: 'ACCEPTED',
              onRose: true,
            },
          ],
          integrationShares: [],
          projectShares: [],
        };
        teams.push(team);
        return route.fulfill({ json: team, status: 201 });
      }
      if (path === '/api/teams') body = { teams, invitations: [] };
      else if (path === '/api/teams/contacts')
        body = {
          contacts: [
            { name: 'Tamy', email: 'tamara@roselabs.ai', userId: 'fixture-tamy', onRose: true },
          ],
        };
      else if (path === '/api/teams/shareable-integrations') body = { integrations: accounts };
      else if (path === '/api/teams/team-rose/invites') {
        const member = {
          id: 'tamy-member',
          userId: 'fixture-tamy',
          name: 'Tamy',
          email: request.postDataJSON().email,
          role: 'MEMBER' as const,
          status: 'INVITED' as const,
          onRose: true,
          inviteDeliveryStatus: 'SENT' as const,
        };
        teams[0].members.push(member);
        body = { member, delivery: 'sent' };
      } else if (path === '/api/teams/team-rose' && request.method() === 'PATCH') {
        teams[0].name = request.postDataJSON().name;
        body = teams[0];
      } else if (path.includes('/teams/team-rose/integrations/')) {
        const account = accounts.find((item) => item.id === path.split('/').at(-1))!;
        if (request.method() === 'PUT')
          teams[0].integrationShares.push({
            id: `share-${account.id}`,
            teamId: teams[0].id,
            integrationId: account.integrationId,
            ownerUserId: viewerId,
            ownerName: 'Fixture owner',
            provider: account.provider,
            accountId: account.accountId,
            accountEmail: account.accountEmail,
          });
        else
          teams[0].integrationShares = teams[0].integrationShares.filter(
            (share) => share.accountId !== account.accountId,
          );
        body = teams[0];
      } else if (path.includes('/teams/team-rose/projects/')) {
        if (request.method() === 'PUT')
          teams[0].projectShares.push({
            id: 'project-share',
            projectId: project.id,
            teamId: teams[0].id,
            teamName: teams[0].name,
            ownerUserId: viewerId,
            ownerName: 'Fixture owner',
            name: project.name,
            createdAt: now,
          });
        else teams[0].projectShares = [];
        body = teams[0];
      } else if (path === '/api/projects') body = { projects: [project] };
      else if (path.endsWith('/maintenance'))
        body = {
          snapshot: null,
          running: false,
          nextRunAt: null,
          watchCheckedAt: null,
          runs: [],
        };
      else if (path.endsWith('/env-files')) body = { envFiles: [] };
      else if (path === '/api/projects/cli-login-codes')
        body = { code: 'fixture-code', expiresAt: now, project: null };
      else if (path === '/api/agents') body = { agents: [] };
      else if (path === '/api/agents/code-agents') body = { code_agents: [] };
      else if (path === '/api/attention-requests') body = { requests: [] };
      else if (path === '/api/invite-codes/check') body = { needsInviteCode: false };
      else if (path === '/api/models') body = { models: [] };
      else if (path === '/api/tools') body = { tools: [] };
      else if (path === '/api/integrations')
        body = {
          integrations: [
            {
              id: 'gmail-parent',
              name: 'gmail',
              status: 'CONNECTED',
              isActive: true,
              config: { connectedEmails: ['owner@roselabs.ai', 'private@example.test'] },
              emailCredentials: ['owner@roselabs.ai', 'private@example.test'].map((email) => ({
                email,
                state: 'connected',
                lastErrorReason: null,
              })),
            },
            { id: 'messages', name: 'imessage', status: 'CONNECTED', isActive: true, config: {} },
          ],
        };
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
      else if (path === '/api/integrations/plaid/items') body = { items: [] };
      else if (path === '/api/integrations/progress') body = { cursor: now, changed: false };
      else if (path === '/api/user-settings') body = { name: 'Fixture owner' };
      else if (path === '/api/user-ui/active') body = { versionId: null };
      else if (path === '/api/user-ui/versions') body = { versions: [] };
      else if (path === '/api/iphone/connection')
        body = {
          enabled: false,
          configured: false,
          status: 'not_connected',
          setupAgentId: null,
          connectionRevision: 0,
        };
      await route.fulfill({ json: body });
    });
    await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const badge = document.createElement('div');
      badge.textContent = 'UI FIXTURE · No real emails or grants';
      badge.style.cssText =
        'position:fixed;bottom:6px;left:6px;z-index:10000;padding:5px 9px;background:#172033;color:white;font:11px sans-serif;border-radius:5px;pointer-events:none';
      document.body.appendChild(badge);
    });
    if (width >= 768) {
      const bar = page.getByTestId('rose-sidebar');
      await expect(bar).toBeVisible();
      await bar.hover({ position: { x: 30, y: 90 } });
      await page.getByRole('button', { name: 'Teams', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      await page.getByRole('button', { name: 'Teams', exact: true }).click();
    }
    await expect(page.getByText('Your first team starts here')).toBeVisible();
    await page.getByLabel('New team title').fill('Rose Labs');
    await page.getByRole('button', { name: 'Create team', exact: true }).click();
    await expect(page.getByLabel('Team title', { exact: true })).toHaveValue('Rose Labs');
    await page.getByRole('combobox').fill('Tam');
    const contact = page.getByRole('option', { name: /Tamy/ });
    await expect(contact).toContainText('On Rose');
    await page.screenshot({
      path: resolve(evidence, `teams-autocomplete-${width}.png`),
      fullPage: true,
    });
    await contact.click();
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(page.getByText(/Invitation saved for tamara/)).toBeVisible();
    await expect(page.getByText(/Invited · awaiting acceptance/)).toBeVisible();
    const work = page.getByRole('checkbox', {
      name: 'Share gmail · owner@roselabs.ai',
      exact: true,
    });
    const personal = page.getByRole('checkbox', {
      name: 'Share gmail · private@example.test',
      exact: true,
    });
    await work.click();
    await expect(work).toBeChecked();
    await expect(personal).not.toBeChecked();
    const projectShare = page.getByRole('checkbox', { name: 'Share project Rose', exact: true });
    await projectShare.click();
    await expect(projectShare).toBeChecked();
    await page.screenshot({
      path: resolve(evidence, `teams-shared-${width}.png`),
      fullPage: true,
    });
    await work.click();
    await expect(work).not.toBeChecked();
    await expect(personal).not.toBeChecked();
    if (width >= 768) {
      await page.getByTestId('rose-sidebar').hover({ position: { x: 30, y: 90 } });
      await page.getByRole('button', { name: 'Teams', exact: true }).click();
      await page.getByRole('button', { name: 'Integrations', exact: true }).click();
      const settings = page.getByRole('region', { name: 'Integration team sharing' });
      await expect(settings).toBeVisible();
      await settings.getByRole('checkbox', { name: /owner@roselabs.ai with Rose Labs/ }).click();
      await expect(
        settings.getByRole('checkbox', { name: /private@example.test/ }),
      ).not.toBeChecked();
      await page.screenshot({
        path: resolve(evidence, 'integration-sharing-1280.png'),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Integrations', exact: true }).click();
      await page.getByTestId('rose-sidebar').hover({ position: { x: 30, y: 90 } });
      await page.getByRole('button', { name: 'Rose project settings', exact: true }).click();
      const projectSettings = page.getByRole('region', { name: 'Project team sharing' });
      await expect(
        projectSettings.getByRole('checkbox', { name: 'Share project with Rose Labs' }),
      ).toBeChecked();
      await page.screenshot({
        path: resolve(evidence, 'project-sharing-1280.png'),
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
    expect(teams[0].members[1].email).toBe('tamara@roselabs.ai');
    expect(teams[0].members[1].status).toBe('INVITED');
    expect(teams[0].projectShares).toHaveLength(1);
  });
}
