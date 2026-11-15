/**
 * Team sharing lives on each shareable Integrations account (Gmail address, iMessage):
 * a "Shared with …" / "Share" caption beside the account opens one checkbox per team,
 * even with a single team; there is no page-level sharing card and no "Stop sharing".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { TeamIntegrationShare } from '@/lib/api/teams';
import {
  account,
  listOf,
  one,
  renderIntegrations,
  row,
  rowEl,
  serveList,
} from './integrations-accounts.fixtures';
import { mockSession } from './app-sidebar.fixtures';
import { server } from './msw/server';
import { accounts, makeTeam, mockTeams, owner, TEAM_API } from './teams.fixtures';

const EMAILS = ['work@example.test', 'private@example.test'];

/** Two connected Gmail addresses and the Mac's iMessage, as GET /integrations returns them. */
function serveMessages() {
  const gmail = EMAILS.map((email) => account('gmail', email, { label: email }));
  const credentials = EMAILS.map((email) => ({
    id: `cred-${email}`,
    email,
    state: 'connected',
    lastErrorReason: null,
    lastFailedSyncAt: null,
  }));
  serveList(() =>
    listOf(
      row('gmail', gmail, { emailCredentials: credentials }),
      one('imessage', { state: 'synced' }),
    ),
  );
}

/** An existing grant of one shareable fixture account (by its selector id) to a team. */
function grant(teamId: string, selector: string): TeamIntegrationShare {
  const shared = accounts.find((item) => item.id === selector)!;
  return {
    id: `share-${teamId}-${selector}`,
    teamId,
    integrationId: shared.integrationId,
    ownerUserId: 'test-user',
    ownerName: 'Owner',
    provider: shared.provider,
    accountId: shared.accountId,
    accountEmail: shared.accountEmail,
  };
}

const member = {
  ...owner,
  id: 'teammate',
  userId: 'teammate',
  email: 'tamy@example.test',
  name: 'Tamy',
  role: 'MEMBER' as const,
};

describe('Integrations: per-account team sharing', () => {
  beforeEach(() => mockSession());
  afterEach(() => localStorage.clear());

  it('puts a Share caption on each account and still asks via a checkbox with one team', async () => {
    const api = mockTeams([makeTeam()]);
    serveMessages();
    const user = userEvent.setup();
    renderIntegrations();
    const gmail = await screen.findByTestId('integration-row-gmail');
    const work = await within(gmail).findByRole('button', { name: 'Share work@example.test' });
    expect(within(gmail).getByRole('button', { name: 'Share private@example.test' })).toBeVisible();
    expect(within(rowEl('imessage')).getByRole('button', { name: 'Share iMessage' })).toBeVisible();
    expect(screen.queryByText('Share integration data with teams')).toBeNull();

    await user.click(work);
    const picker = await screen.findByRole('dialog', {
      name: 'Share work@example.test with teams',
    });
    expect(within(picker).getByText('1 member')).toBeVisible();
    const team = within(picker).getByRole('checkbox', { name: 'Rose Labs' });
    expect(team).not.toBeChecked();
    await user.click(team);
    await waitFor(() => expect(team).toBeChecked());
    expect(api.writes).toEqual([
      { method: 'PUT', path: '/team-rose/integrations/mail-work', body: {} },
    ]);
    expect(
      await within(gmail).findByRole('button', { name: 'work@example.test shared with Rose Labs' }),
    ).toBeVisible();
    expect(within(gmail).getByRole('button', { name: 'Share private@example.test' })).toBeVisible();
  });

  it('unshares from the caption by unticking the team; there is no Stop sharing', async () => {
    const api = mockTeams([makeTeam({ integrationShares: [grant('team-rose', 'mail-work')] })]);
    serveMessages();
    const user = userEvent.setup();
    renderIntegrations();
    await user.click(
      await screen.findByRole('button', { name: 'work@example.test shared with Rose Labs' }),
    );
    const picker = await screen.findByRole('dialog', {
      name: 'Share work@example.test with teams',
    });
    expect(within(picker).queryByText(/stop sharing/i)).toBeNull();
    const team = within(picker).getByRole('checkbox', { name: 'Rose Labs' });
    expect(team).toBeChecked();
    await user.click(team);
    await waitFor(() => expect(team).not.toBeChecked());
    expect(api.writes).toEqual([
      { method: 'DELETE', path: '/team-rose/integrations/mail-work', body: null },
    ]);
    expect(
      await within(rowEl('gmail')).findByRole('button', { name: 'Share work@example.test' }),
    ).toBeVisible();
  });

  it('names every team on hover and unshares one team without touching the other', async () => {
    const api = mockTeams([
      makeTeam({
        members: [{ ...owner }, member],
        integrationShares: [grant('team-rose', 'imessage-parent')],
      }),
      makeTeam({
        id: 'second',
        name: 'Second team',
        integrationShares: [grant('second', 'imessage-parent')],
      }),
    ]);
    serveMessages();
    const user = userEvent.setup();
    renderIntegrations();
    const caption = await within(await screen.findByTestId('integration-row-imessage')).findByRole(
      'button',
      { name: 'iMessage shared with 2 teams' },
    );
    await user.hover(caption);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Rose Labs');
    expect(tooltip).toHaveTextContent('Second team');

    await user.click(caption);
    const picker = await screen.findByRole('dialog', { name: 'Share iMessage with teams' });
    expect(within(picker).getByText('2 members')).toBeVisible();
    expect(within(picker).getByRole('checkbox', { name: 'Rose Labs' })).toBeChecked();
    const second = within(picker).getByRole('checkbox', { name: 'Second team' });
    await user.click(second);
    await waitFor(() => expect(second).not.toBeChecked());
    expect(api.writes).toEqual([
      { method: 'DELETE', path: '/second/integrations/imessage-parent', body: null },
    ]);
    expect(api.state.teams[0].integrationShares).toHaveLength(1);
    expect(
      await within(rowEl('imessage')).findByRole('button', {
        name: 'iMessage shared with Rose Labs',
      }),
    ).toBeVisible();
  });

  it('gives the stock page the same caption beside each Gmail address and iMessage', async () => {
    const api = mockTeams([makeTeam()]);
    serveMessages();
    const user = userEvent.setup();
    renderIntegrations({ roseDesktop: false });
    const section = (await screen.findByText('Messages')).closest<HTMLElement>('.rounded-lg')!;
    await user.click(within(section).getAllByRole('button')[0]);
    expect(await within(section).findByRole('button', { name: 'Share iMessage' })).toBeVisible();
    expect(
      within(section).getByRole('button', { name: 'Share private@example.test' }),
    ).toBeVisible();
    await user.click(within(section).getByRole('button', { name: 'Share work@example.test' }));
    const picker = await screen.findByRole('dialog', {
      name: 'Share work@example.test with teams',
    });
    await user.click(within(picker).getByRole('checkbox', { name: 'Rose Labs' }));
    expect(
      await within(section).findByRole('button', {
        name: 'work@example.test shared with Rose Labs',
      }),
    ).toBeVisible();
    expect(api.writes).toEqual([
      { method: 'PUT', path: '/team-rose/integrations/mail-work', body: {} },
    ]);
  });

  it('shows one page-level alert and no captions when sharing fails to load', async () => {
    mockTeams();
    server.use(http.get(TEAM_API, () => HttpResponse.json({})));
    serveMessages();
    renderIntegrations();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Team sharing unavailable: Unexpected Teams response');
    expect(await screen.findByText('work@example.test')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Share |shared with/ })).toBeNull();
  });
});
