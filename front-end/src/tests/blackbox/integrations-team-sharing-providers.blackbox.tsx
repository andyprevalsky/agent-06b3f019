/**
 * Every shareable Integrations account carries the same team-sharing caption, in both
 * presentations: WhatsApp, LinkedIn, Granola, Fireflies, each Plaid institution, each
 * Claude / ChatGPT subscription account, each GitHub repo, each CLI and each MCP server. The caption
 * names the account by its label, opens one checkbox per team and PUTs / DELETEs that
 * account's exact selector. iPhone, Browser Cookies, the Passwords rows and Pebble
 * Index 01 never get one, even when the shareable list (wrongly) contains them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ShareableIntegration, TeamIntegrationShare } from '@/lib/api/teams';
import {
  API_BASE,
  computeAccount,
  desktopHandlers,
  listOf,
  one,
  renderIntegrations,
  rowEl,
  serveList,
} from './integrations-accounts.fixtures';
import { mockSession } from './app-sidebar.fixtures';
import { server } from './msw/server';
import { makeItem } from './plaid.fixtures';
import { makeProject, mockProjectsApi } from './rose-sidebar.fixtures';
import { accounts, makeTeam, mockTeams, unshareableAccounts } from './teams.fixtures';

const handlers = () =>
  desktopHandlers({
    iMessage: { isAvailable: true, onClick: async () => {} },
    claudeCode: {
      isAvailable: true,
      hasCredentials: async () => true,
      syncCredentials: async () => ({ success: true }),
    },
    gptCode: {
      isAvailable: true,
      hasCredentials: async () => true,
      syncCredentials: async () => ({ success: true }),
    },
  });

const notes = (email: string, document: string) => ({
  connected: true,
  status: 'CONNECTED',
  accountEmail: email,
  backfillDone: true,
  lastSuccessfulSyncAt: null,
  lastError: null,
  documents: { [document]: 3 },
});

/** A GitHub repository in Integrations › GitHub Repositories (one project per repo). */
const repo = (name: string) =>
  makeProject({
    id: `p-${name}`,
    name,
    repoUrl: `https://github.com/rose-ai-labs/${name}`,
    isFolder: false,
    isRepository: true,
  });

const cli = (id: string, name: string) => ({
  id,
  name,
  request: name,
  status: 'connected',
  agent_id: null,
  error: null,
});

const mcpServer = (id: string, name: string, url: string) => ({
  id,
  name,
  url,
  auth: 'none',
  status: 'connected',
  tools: [{ name: 'resolve-library-id', description: 'Resolve a library' }],
  error: null,
});

/**
 * Every shareable provider connected. Each multi-account row also has a sibling the
 * backend does not list (second Claude account, docs repository, GitHub CLI, internal MCP server):
 * it gets no caption.
 */
function serveProviders() {
  serveList(() =>
    listOf(
      one('whatsapp', { state: 'synced' }),
      one('linkedin', { state: 'synced' }),
      one('granola', { state: 'synced' }),
      one('fireflies', { state: 'synced' }),
    ),
  );
  mockProjectsApi([repo('rose'), repo('docs')], {});
  const second = { id: 'item-uuid-2', plaidItemId: 'plaid_item_2', institutionId: 'ins_2' };
  server.use(
    http.get(`${API_BASE}/integrations/plaid/items`, () =>
      HttpResponse.json({
        items: [makeItem(), makeItem({ ...second, institutionName: 'Second Bank' })],
      }),
    ),
    http.get(`${API_BASE}/compute-accounts`, ({ request }) =>
      HttpResponse.json({
        accounts:
          new URL(request.url).searchParams.get('provider') === 'codex'
            ? [computeAccount('acct-codex-1', 'codex@example.test', { provider: 'codex' })]
            : [
                computeAccount('acct-claude-1', 'claude@example.test'),
                computeAccount('acct-claude-2', 'second@example.test'),
              ],
      }),
    ),
    http.get(`${API_BASE}/integrations/cli`, () =>
      HttpResponse.json({ integrations: [cli('cli-yc', 'YC CLI'), cli('cli-gh', 'GitHub CLI')] }),
    ),
    http.get(`${API_BASE}/integrations/mcp`, () =>
      HttpResponse.json({
        servers: [
          mcpServer('mcp-docs', 'Context7', 'https://mcp.context7.com/mcp'),
          mcpServer('mcp-internal', 'Internal Tools', 'https://tools.example.test/mcp'),
        ],
      }),
    ),
    http.get(`${API_BASE}/integrations/granola`, () =>
      HttpResponse.json(notes('andy@example.com', 'granola_note')),
    ),
    http.get(`${API_BASE}/integrations/fireflies`, () =>
      HttpResponse.json(notes('notes@example.test', 'fireflies_note')),
    ),
  );
}

const MESSAGES = "Teammates' agents can read this account's messages.";
const MEETINGS = "Teammates' agents can read this account's meeting notes.";
const SUBSCRIPTION = "Teammates' agents can use this subscription after their own.";

interface Case {
  row: string;
  /** The caption is `Share <label>`, its picker `Share <label> with teams`. */
  label: string;
  /** PUT / DELETE /teams/team-rose/integrations/<selector>. */
  selector: string;
  effect: string;
  /** Where the caption must be, per presentation. */
  desktop: () => HTMLElement;
  stock: () => HTMLElement;
  /** Stock accordion holding the row ("Manage <section> connections"). */
  section?: string;
  /** The row's other account the backend does not list (or keeps private). */
  sibling?: { name: string; caption: string | null };
}

const region = (name: string) => () => screen.getByRole('region', { name });
const card = (heading: string) => () =>
  screen.getByRole('heading', { name: heading }).closest<HTMLElement>('.rounded-lg')!;
/** A stock accordion row: the row element around its name. */
const stockRow = (name: string) => () =>
  screen.getByText(name, { selector: 'span' }).closest<HTMLElement>('.px-4')!;

const CASES: Case[] = [
  {
    row: 'WhatsApp',
    label: 'WhatsApp',
    selector: 'int-whatsapp',
    effect: MESSAGES,
    desktop: () => rowEl('whatsapp'),
    stock: stockRow('WhatsApp'),
    section: 'Messages',
  },
  {
    row: 'LinkedIn',
    label: 'LinkedIn',
    selector: 'int-linkedin',
    effect: MESSAGES,
    desktop: () => rowEl('linkedin'),
    stock: stockRow('LinkedIn'),
    section: 'Socials',
  },
  {
    row: 'Granola',
    label: 'andy@example.com',
    selector: 'int-granola',
    effect: MEETINGS,
    desktop: () => rowEl('granola'),
    stock: card('Granola'),
  },
  {
    row: 'Fireflies',
    label: 'notes@example.test',
    selector: 'int-fireflies',
    effect: MEETINGS,
    desktop: () => rowEl('fireflies'),
    stock: card('Fireflies'),
  },
  {
    row: 'Plaid',
    label: 'First Platypus Bank',
    selector: 'item-uuid-1',
    effect: "Teammates' agents can read this institution's transactions.",
    desktop: () => rowEl('plaid'),
    stock: card('Banks & Financial Accounts'),
    sibling: { name: 'Second Bank', caption: 'Share Second Bank' },
  },
  {
    row: 'Claude Subscription',
    label: 'claude@example.test',
    selector: 'int-claude-acct',
    effect: SUBSCRIPTION,
    desktop: () => rowEl('claude'),
    stock: stockRow('Claude Subscription'),
    section: 'Compute',
    sibling: { name: 'second@example.test', caption: null },
  },
  {
    row: 'ChatGPT Subscription',
    label: 'codex@example.test',
    selector: 'int-codex-acct',
    effect: SUBSCRIPTION,
    desktop: () => rowEl('codex'),
    stock: stockRow('ChatGPT Subscription'),
    section: 'Compute',
  },
  {
    row: 'GitHub repo',
    label: 'gh:rose-ai-labs/rose',
    selector: 'int-gh-rose',
    effect: "Teammates' code agents can use this repo.",
    desktop: region('GitHub Repositories'),
    stock: region('GitHub Repositories'),
    sibling: { name: 'docs', caption: null },
  },
  {
    row: 'CLI',
    label: 'YC CLI',
    selector: 'cli-yc',
    effect: "Teammates' agents can run this CLI in your sandbox.",
    desktop: region('CLIs'),
    stock: region('CLIs'),
    sibling: { name: 'GitHub CLI', caption: null },
  },
  {
    row: 'MCP server',
    label: 'Context7',
    selector: 'mcp-docs',
    effect: "Teammates' code agents can use this server's tools through your connection.",
    desktop: region('MCP servers'),
    stock: region('MCP servers'),
    sibling: { name: 'Internal Tools', caption: null },
  },
];

/** An existing grant of one fixture account (by selector) to a team. */
function grant(teamId: string, account: ShareableIntegration): TeamIntegrationShare {
  return {
    id: `share-${teamId}-${account.id}`,
    teamId,
    integrationId: account.integrationId,
    ownerUserId: 'test-user',
    ownerName: 'Owner',
    provider: account.provider,
    accountId: account.accountId,
    accountEmail: account.accountEmail,
    label: account.label,
  };
}

const CAPTION = /^Share |shared with/;

describe('Integrations: a team-sharing caption on every shareable account', () => {
  beforeEach(() => mockSession());
  afterEach(() => localStorage.clear());

  describe.each([
    ['Rose Desktop', true],
    ['stock', false],
  ] as const)('%s', (_presentation, roseDesktop) => {
    it.each(CASES)('$row: shares and unshares its exact account', async (c) => {
      const api = mockTeams([makeTeam()]);
      serveProviders();
      const user = userEvent.setup();
      renderIntegrations({ roseDesktop, handlers: handlers() });
      if (!roseDesktop && c.section !== undefined)
        await user.click(
          await screen.findByRole('button', { name: `Manage ${c.section} connections` }),
        );
      const scope = await waitFor(roseDesktop ? c.desktop : c.stock);
      const caption = await within(scope).findByRole('button', { name: `Share ${c.label}` });
      if (c.sibling !== undefined) {
        expect(within(scope).getAllByText(c.sibling.name)[0]).toBeVisible();
        if (c.sibling.caption === null)
          expect(within(scope).getAllByRole('button', { name: CAPTION })).toHaveLength(1);
        else expect(within(scope).getByRole('button', { name: c.sibling.caption })).toBeVisible();
      }

      await user.click(caption);
      const picker = await screen.findByRole('dialog', { name: `Share ${c.label} with teams` });
      expect(within(picker).getByText('Share with teams')).toBeVisible();
      expect(picker).toHaveTextContent(`${c.effect} Credentials stay private.`);
      expect(within(picker).queryByText(/stop sharing/i)).toBeNull();
      const team = within(picker).getByRole('checkbox', { name: 'Rose Labs' });
      await user.click(team);
      await waitFor(() => expect(team).toBeChecked());
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      await user.click(
        await within(scope).findByRole('button', { name: `${c.label} shared with Rose Labs` }),
      );
      const again = await screen.findByRole('dialog', { name: `Share ${c.label} with teams` });
      const shared = within(again).getByRole('checkbox', { name: 'Rose Labs' });
      expect(shared).toBeChecked();
      await user.click(shared);
      await waitFor(() => expect(shared).not.toBeChecked());
      expect(api.writes).toEqual([
        { method: 'PUT', path: `/team-rose/integrations/${c.selector}`, body: {} },
        { method: 'DELETE', path: `/team-rose/integrations/${c.selector}`, body: null },
      ]);
      expect(await within(scope).findByRole('button', { name: `Share ${c.label}` })).toBeVisible();
      if (c.sibling?.caption)
        expect(within(scope).getByRole('button', { name: c.sibling.caption })).toBeVisible();
    });

    it('never captions iPhone, Browser Cookies, Passwords or Pebble Index 01', async () => {
      const imessage = accounts.find((account) => account.provider === 'imessage')!;
      const listed = [...unshareableAccounts, imessage];
      mockTeams(
        [makeTeam({ integrationShares: unshareableAccounts.map((a) => grant('team-rose', a)) })],
        [],
        listed,
      );
      serveList(() =>
        listOf(
          one('chrome', { state: 'synced' }),
          one('chrome_passwords', { state: 'synced' }),
          one('apple_passwords', { state: 'synced' }),
          one('atlas_passwords', { state: 'synced' }),
          one('imessage', { state: 'synced' }),
        ),
      );
      server.use(
        http.get(`${API_BASE}/iphone/connection`, () =>
          HttpResponse.json({
            enabled: true,
            configured: true,
            status: 'ready',
            setupAgentId: null,
            connectionRevision: 1,
          }),
        ),
      );
      const user = userEvent.setup();
      renderIntegrations({ roseDesktop, handlers: handlers() });
      if (!roseDesktop)
        for (const section of ['Browser Cookies', 'Passwords', 'Messages'])
          await user.click(
            await screen.findByRole('button', { name: `Manage ${section} connections` }),
          );
      // Sharing has loaded: the one shareable account (iMessage) has its caption ...
      expect(await screen.findByRole('button', { name: 'Share iMessage' })).toBeVisible();
      expect(await within(rowEl('iphone')).findByText('Connected')).toBeVisible();
      if (roseDesktop) {
        for (const key of ['browser-chrome', 'chrome-passwords', 'apple-passwords']) {
          expect(rowEl(key).querySelector('[data-tone]')).not.toBeNull();
          expect(within(rowEl(key)).queryByRole('button', { name: CAPTION })).toBeNull();
        }
        for (const key of ['atlas-passwords', 'iphone', 'pebble-index'])
          expect(within(rowEl(key)).queryByRole('button', { name: CAPTION })).toBeNull();
      } else {
        expect(screen.getByText('Pebble Index 01')).toBeVisible();
      }
      // ... and nothing else on the page, though every excluded account is listed and shared.
      expect(screen.getAllByRole('button', { name: CAPTION })).toHaveLength(1);
    });
  });
});
