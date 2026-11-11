/** Teams UI through real components and authenticated HTTP boundaries. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import Teams from '@/pages/Teams';
import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { IntegrationTeamSharing, ProjectTeamSharing } from '@/components/teams/TeamSharing';
import { clearTeamInviteLink } from '@/lib/teamInviteLink';
import { AUTH_SESSION_CHANGED_EVENT } from '@/lib/supabase';
import { renderWithProviders } from './test-wrapper';
import { defaultProps, mockSession, renderStockSidebar } from './app-sidebar.fixtures';
import { makeProject, mockProjectsApi, roseBar } from './rose-sidebar.fixtures';
import { accounts, makeTeam, mockTeams, owner, TEAM_API } from './teams.fixtures';
import { server } from './msw/server';

describe('Teams', () => {
  afterEach(() => {
    clearTeamInviteLink();
    window.history.replaceState(null, '', '/');
  });
  beforeEach(() => {
    localStorage.clear();
    mockSession();
    mockProjectsApi([makeProject()]);
  });
  it('creates a titled team without silently inviting or sharing anything', async () => {
    const api = mockTeams([]);
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    await screen.findByText('Your first team starts here');
    expect(screen.getByRole('button', { name: 'Create team' })).toBeDisabled();
    await user.type(screen.getByLabelText('New team title'), 'Rose Labs');
    await user.click(screen.getByRole('button', { name: 'Create team' }));
    expect(await screen.findByLabelText('Team title')).toHaveValue('Rose Labs');
    expect(api.writes).toEqual([{ method: 'POST', path: '', body: { name: 'Rose Labs' } }]);
    expect(api.state.teams[0].integrationShares).toEqual([]);
    expect(api.state.teams[0].members).toHaveLength(1);
    for (const checkbox of await screen.findAllByRole('checkbox'))
      expect(checkbox).not.toBeChecked();
  });
  it('renames only the selected team', async () => {
    const api = mockTeams([makeTeam(), makeTeam({ id: 'other', name: 'Other team' })]);
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    await user.clear(await screen.findByLabelText('Team title'));
    await user.type(screen.getByLabelText('Team title'), 'Rose research');
    await user.click(screen.getByRole('button', { name: 'Save title' }));
    await waitFor(() => expect(api.state.teams[0].name).toBe('Rose research'));
    await user.click(screen.getByRole('button', { name: 'Other team' }));
    expect(screen.getByLabelText('Team title')).toHaveValue('Other team');
    expect(api.writes[0]).toEqual({
      method: 'PATCH',
      path: '/team-rose',
      body: { name: 'Rose research' },
    });
  });
  it('autocompletes exact saved email, shows on-Rose status, and keeps invitations pending', async () => {
    const api = mockTeams();
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    await user.type(await screen.findByRole('combobox', { name: 'Invite by email' }), 'Tam');
    const option = await screen.findByRole('option');
    expect(option).toHaveTextContent('tamara@roselabs.ai · On Rose');
    await user.click(option);
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText(/Invitation saved for tamara/)).toBeInTheDocument();
    expect(screen.getByText(/Invited · awaiting acceptance/)).toBeInTheDocument();
    expect(api.writes[0].body).toEqual({ email: 'tamara@roselabs.ai' });
    expect(api.state.teams[0].integrationShares).toEqual([]);
    expect(api.state.teams[0].members[1].status).toBe('INVITED');
  });
  it('supports keyboard selection and blocks a duplicate pending invitation', async () => {
    const api = mockTeams();
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    const input = await screen.findByRole('combobox');
    await user.type(input, 'Tam');
    await screen.findByRole('option');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(input).toHaveValue('tamara@roselabs.ai');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    await screen.findByText(/Invitation saved for/);
    await user.type(input, 'tamara@roselabs.ai');
    expect(screen.getByRole('button', { name: 'Invite' })).toBeDisabled();
    expect(screen.getByText('Invitation already pending.')).toBeInTheDocument();
    expect(api.writes).toHaveLength(1);
  });
  it('distinguishes an off-Rose invite from joined membership', async () => {
    mockTeams();
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    await user.type(await screen.findByRole('combobox'), 'new@example.test');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText(/Invitation saved for new@example.test/)).toHaveTextContent(
      'must accept',
    );
    expect(screen.getByText('Not on Rose yet')).toBeInTheDocument();
  });
  it('refreshes membership and on-Rose status from the server', async () => {
    const api = mockTeams();
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    await screen.findByLabelText('Team title');
    api.state.teams[0].members.push({
      ...owner,
      id: 'new',
      userId: 'new-user',
      email: 'new@example.test',
      name: 'New member',
      role: 'MEMBER',
      onRose: true,
    });
    await user.click(screen.getByRole('button', { name: 'Refresh teams' }));
    expect(await screen.findByText('New member')).toBeInTheDocument();
    expect(
      within(screen.getByText('New member').closest('li')!).getByText(/On Rose/),
    ).toBeInTheDocument();
  });
  it('accepts email-token invitations explicitly; members cannot rename or invite', async () => {
    window.history.replaceState(
      null,
      '',
      '/?team-invite=invitation#team-invite-token=secret-proof',
    );
    const api = mockTeams(
      [],
      [makeTeam({ id: 'invitation', name: 'Shared lab', role: 'MEMBER', status: 'INVITED' })],
    );
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByRole('heading', { name: 'Shared lab' })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('');
    expect(screen.queryByLabelText('Team title')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(api.state.invitations).toEqual([]);
    expect(api.writes[0].body).toEqual({ token: 'secret-proof' });
  });
  it('isolates sibling email accounts under one integration and revokes the selected account', async () => {
    const api = mockTeams();
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    const work = await screen.findByRole('checkbox', { name: 'Share gmail · work@example.test' });
    const personal = screen.getByRole('checkbox', { name: 'Share gmail · private@example.test' });
    expect(work).not.toBeChecked();
    expect(personal).not.toBeChecked();
    await user.click(work);
    await waitFor(() => expect(work).toBeChecked());
    expect(personal).not.toBeChecked();
    await user.click(personal);
    await waitFor(() => expect(personal).toBeChecked());
    await user.click(work);
    await waitFor(() => expect(work).not.toBeChecked());
    expect(personal).toBeChecked();
    expect(api.state.teams[0].integrationShares.map((share) => share.accountId)).toEqual([
      'private@example.test',
    ]);
    expect(api.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      'PUT /team-rose/integrations/mail-work',
      'PUT /team-rose/integrations/mail-personal',
      'DELETE /team-rose/integrations/mail-work',
    ]);
    expect(screen.queryByRole('checkbox', { name: /iPhone/i })).toBeNull();
  });
  it('shares and revokes projects independently', async () => {
    const api = mockTeams();
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    const project = await screen.findByRole('checkbox', { name: 'Share project Rose' });
    await user.click(project);
    await waitFor(() => expect(project).toBeChecked());
    expect(api.state.teams[0].projectShares[0].projectId).toBe('p-rose');
    await user.click(project);
    await waitFor(() => expect(project).not.toBeChecked());
  });
  it('confirms member removal and never offers to remove the owner', async () => {
    const api = mockTeams([
      makeTeam({
        members: [
          { ...owner },
          {
            ...owner,
            id: 'member-tamy',
            role: 'MEMBER',
            userId: 'tamy-user',
            name: 'Tamy',
            email: 'tamara@roselabs.ai',
          },
        ],
      }),
    ]);
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    expect(
      await screen.findByRole('button', { name: 'Remove tamara@roselabs.ai' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove owner@example.test' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove tamara@roselabs.ai' }));
    expect(api.writes).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }));
    await waitFor(() => expect(screen.queryByText('Tamy')).toBeNull());
    expect(api.writes[0].path).toBe('/team-rose/members/member-tamy');
  });
  it('displays load errors and retries', async () => {
    mockTeams();
    server.use(
      http.get(TEAM_API, () =>
        HttpResponse.json({ error: 'Temporarily unavailable' }, { status: 503 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporarily unavailable');
    server.use(
      http.get(TEAM_API, () => HttpResponse.json({ teams: [makeTeam()], invitations: [] })),
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Team title')).toHaveValue('Rose Labs');
  });
  it('keeps failed opt-in unchecked and exposes the server error', async () => {
    mockTeams();
    server.use(
      http.put(`${TEAM_API}/:teamId/integrations/:id`, () =>
        HttpResponse.json({ error: 'Account disconnected' }, { status: 403 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    const work = await screen.findByRole('checkbox', { name: 'Share gmail · work@example.test' });
    await user.click(work);
    expect(await screen.findByRole('alert')).toHaveTextContent('Account disconnected');
    expect(work).not.toBeChecked();
  });
  it('does not reuse the previous user cache after a session switch', async () => {
    mockTeams();
    renderWithProviders(<Teams />);
    await screen.findByLabelText('Team title');
    server.use(http.get(TEAM_API, () => HttpResponse.json({ teams: [], invitations: [] })));
    const session = JSON.parse(localStorage.getItem('rose-session')!);
    session.user.id = 'different-user';
    localStorage.setItem('rose-session', JSON.stringify(session));
    fireEvent(window, new Event(AUTH_SESSION_CHANGED_EVENT));
    expect(await screen.findByText('Your first team starts here')).toBeInTheDocument();
    expect(screen.queryByLabelText('Team title')).toBeNull();
  });
  it('shows a sign-in state without requesting private teams', async () => {
    const api = mockTeams();
    localStorage.clear();
    renderWithProviders(<Teams />);
    expect(screen.getByText('Sign in to create or join a team.')).toBeInTheDocument();
    expect(api.writes).toEqual([]);
  });
  it('offers the same account-specific team selections in Integrations', async () => {
    const api = mockTeams([makeTeam(), makeTeam({ id: 'second', name: 'Second team' })]);
    const user = userEvent.setup();
    renderWithProviders(<IntegrationTeamSharing />);
    const first = await screen.findByRole('checkbox', {
      name: 'Share gmail · work@example.test with Rose Labs',
    });
    await user.click(first);
    await waitFor(() => expect(first).toBeChecked());
    expect(
      screen.getByRole('checkbox', { name: 'Share gmail · work@example.test with Second team' }),
    ).not.toBeChecked();
    expect(api.state.teams[1].integrationShares).toEqual([]);
  });
  it('offers immediate, independent sharing in Project Settings', async () => {
    const api = mockTeams();
    const user = userEvent.setup();
    renderWithProviders(<ProjectTeamSharing projectId="p-rose" />);
    const checkbox = await screen.findByRole('checkbox', { name: 'Share project with Rose Labs' });
    await user.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(api.writes[0].path).toBe('/team-rose/projects/p-rose');
  });
  it('reports a malformed sharing response instead of crashing its host settings', async () => {
    mockTeams();
    server.use(
      http.get(TEAM_API, () => HttpResponse.json({})),
      http.get(`${TEAM_API}/shareable-integrations`, () => HttpResponse.json({})),
    );
    renderWithProviders(
      <>
        <p>Project settings host</p>
        <ProjectTeamSharing projectId="p-rose" />
        <IntegrationTeamSharing />
      </>,
    );
    const alerts = await screen.findAllByRole('alert');
    for (const alert of alerts) expect(alert).toHaveTextContent('Unexpected Teams response');
    expect(screen.getByText('Project settings host')).toBeVisible();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('opens and closes Teams from the Rose drawer beside Biz health', async () => {
    mockTeams();
    const user = userEvent.setup();
    renderWithProviders(<AppSidebar {...defaultProps({ showAdminHealth: true })} />);
    const bar = roseBar();
    const labels = [...bar.querySelectorAll('button')].map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(labels.indexOf('Teams')).toBe(labels.indexOf('Biz health') + 1);
    const button = within(bar).getByRole('button', { name: 'Teams' });
    await user.click(button);
    expect(await screen.findByLabelText('Team title')).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('rose-app-panel').className).toContain('z-[102]');
    await user.click(button);
    expect(screen.getByTestId('rose-app-panel')).toHaveAttribute('data-state', 'closed');
  });
  it('exposes Teams navigation in the stock sidebar for every user', async () => {
    const { vi } = await import('vitest');
    const onViewChange = vi.fn();
    const user = userEvent.setup();
    renderStockSidebar(<AppSidebar {...defaultProps({ onViewChange, showAdminHealth: false })} />);
    await user.click(screen.getByRole('button', { name: 'Teams' }));
    expect(onViewChange).toHaveBeenCalledWith('teams');
  });
  it('never accepts an invitation without its matching email token', async () => {
    mockTeams(
      [],
      [makeTeam({ id: 'invitation', name: 'Private lab', role: 'MEMBER', status: 'INVITED' })],
    );
    window.history.replaceState(
      null,
      '',
      '/?team-invite=other-team#team-invite-token=wrong-team-token',
    );
    renderWithProviders(<Teams />);
    expect(
      await screen.findByText('Open the invitation email to accept securely.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
  });
  it.each(['SENT', 'FAILED', 'UNKNOWN', 'UNAVAILABLE', 'PENDING', 'SENDING'] as const)(
    'reports %s email delivery separately from membership',
    async (deliveryStatus) => {
      mockTeams();
      server.use(
        http.post(`${TEAM_API}/:id/invites`, () =>
          HttpResponse.json(
            {
              member: { ...owner, status: 'INVITED', inviteDeliveryStatus: deliveryStatus },
              delivery: deliveryStatus.toLowerCase(),
            },
            { status: 201 },
          ),
        ),
      );
      const user = userEvent.setup();
      renderWithProviders(<Teams />);
      await user.type(await screen.findByRole('combobox'), 'new@example.test');
      await user.click(screen.getByRole('button', { name: 'Invite' }));
      const receipt = await screen.findByText(/Invitation saved for new@example.test/);
      const labels = {
        SENT: 'Email sent',
        FAILED: 'Email delivery failed',
        UNKNOWN: 'Email delivery unconfirmed',
        UNAVAILABLE: 'Email delivery unavailable',
        PENDING: 'Email pending',
        SENDING: 'Sending email',
      };
      expect(receipt).toHaveTextContent(labels[deliveryStatus]);
      expect(receipt).toHaveTextContent('must accept before any access is granted');
    },
  );
  it('allows an exact email when contact lookup fails and displays invite failure', async () => {
    mockTeams();
    server.use(
      http.get(`${TEAM_API}/contacts`, () =>
        HttpResponse.json({ error: 'Lookup failed' }, { status: 503 }),
      ),
      http.post(`${TEAM_API}/:id/invites`, () =>
        HttpResponse.json({ error: 'Duplicate or ambiguous email' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    await user.type(await screen.findByRole('combobox'), 'new@example.test');
    expect(await screen.findByText(/Contact lookup failed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect(await screen.findByText('Duplicate or ambiguous email')).toBeInTheDocument();
    expect(screen.queryByText(/Invitation saved/)).toBeNull();
  });
  it('shows other owners shared metadata without offering a mutation for their resources', async () => {
    mockTeams([
      makeTeam({
        integrationShares: [
          {
            id: 'foreign',
            teamId: 'team-rose',
            integrationId: 'other-integration',
            ownerUserId: 'other-user',
            ownerName: 'Teammate',
            provider: 'gmail',
            accountId: 'colleague@example.test',
            accountEmail: 'colleague@example.test',
          },
        ],
        projectShares: [
          {
            id: 'foreign-project',
            projectId: 'other-project',
            teamId: 'team-rose',
            teamName: 'Rose Labs',
            ownerUserId: 'other-user',
            ownerName: 'Teammate',
            name: 'Team research',
            createdAt: '2026-11-11T00:00:00Z',
          },
        ],
      }),
    ]);
    renderWithProviders(<Teams />);
    expect(
      await screen.findByText('Teammate shares gmail · colleague@example.test'),
    ).toBeInTheDocument();
    expect(screen.getByText('Team research')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /colleague/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Team research/ })).toBeNull();
  });
  it.each(['FAILED', 'UNAVAILABLE', 'PENDING'] as const)(
    'retries a known-safe %s invitation email without duplicating membership',
    async (status) => {
      const api = mockTeams([
        makeTeam({
          members: [
            { ...owner },
            {
              ...owner,
              id: 'retry-member',
              email: 'retry@example.test',
              role: 'MEMBER',
              status: 'INVITED',
              inviteDeliveryStatus: status,
            },
          ],
        }),
      ]);
      const user = userEvent.setup();
      renderWithProviders(<Teams />);
      await user.click(
        await screen.findByRole('button', { name: 'Retry invitation email to retry@example.test' }),
      );
      await waitFor(() => expect(api.state.teams[0].members[1].inviteDeliveryStatus).toBe('SENT'));
      expect(api.state.teams[0].members).toHaveLength(2);
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /Retry invitation/ })).toBeNull(),
      );
    },
  );
  it.each(['SENT', 'SENDING', 'UNKNOWN'] as const)(
    'does not resend a %s invitation email',
    async (status) => {
      mockTeams([
        makeTeam({
          members: [
            { ...owner },
            {
              ...owner,
              id: 'retry-member',
              email: 'retry@example.test',
              role: 'MEMBER',
              status: 'INVITED',
              inviteDeliveryStatus: status,
            },
          ],
        }),
      ]);
      renderWithProviders(<Teams />);
      await screen.findByText('retry@example.test');
      expect(screen.queryByRole('button', { name: /Retry invitation/ })).toBeNull();
    },
  );
  it('supports a phone-only owner without inventing or dereferencing an email', async () => {
    mockTeams([makeTeam({ members: [{ ...owner, email: null, name: 'Phone owner' }] })]);
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    expect(await screen.findByText('Phone owner (you)')).toBeInTheDocument();
    await user.type(screen.getByRole('combobox'), 'Tam');
    expect(await screen.findByRole('option')).toHaveTextContent('tamara@roselabs.ai');
  });
  it('previews and accepts an email token for a phone account absent from email invitations', async () => {
    const api = mockTeams(
      [],
      [makeTeam({ id: 'phone-invite', name: 'Phone team', role: 'MEMBER', status: 'INVITED' })],
    );
    server.use(
      http.get(TEAM_API, () => HttpResponse.json({ teams: api.state.teams, invitations: [] })),
    );
    window.history.replaceState(
      null,
      '',
      '/?team-invite=phone-invite#team-invite-token=phone-proof',
    );
    const user = userEvent.setup();
    renderWithProviders(<Teams />);
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByRole('heading', { name: 'Phone team' })).toBeInTheDocument();
    expect(api.writes[0].body).toEqual({ token: 'phone-proof' });
    expect(window.location.hash).toBe('');
  });
});
