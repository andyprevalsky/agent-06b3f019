/** In-memory HTTP fixture; no real team, invitation email, or grant is created. */
import { http, HttpResponse } from 'msw';
import type { Team, TeamContact, ShareableIntegration, TeamsResponse } from '@/lib/api/teams';
import { server } from './msw/server';
export const TEAM_API = 'http://localhost:3001/api/teams';
export const owner = {
  id: 'owner-member',
  userId: 'test-user',
  email: 'owner@example.test',
  name: 'Owner',
  role: 'OWNER',
  status: 'ACCEPTED',
  onRose: true,
} as const;
export function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-rose',
    name: 'Rose Labs',
    ownerUserId: 'test-user',
    role: 'OWNER',
    status: 'ACCEPTED',
    createdAt: '2026-11-11T00:00:00Z',
    updatedAt: '2026-11-11T00:00:00Z',
    members: [{ ...owner }],
    integrationShares: [],
    projectShares: [],
    ...overrides,
  };
}
export const accounts: ShareableIntegration[] = [
  {
    id: 'mail-work',
    integrationId: 'gmail-parent',
    provider: 'gmail',
    accountId: 'work@example.test',
    accountEmail: 'work@example.test',
    name: 'gmail',
    status: 'CONNECTED',
    teamIds: [],
  },
  {
    id: 'mail-personal',
    integrationId: 'gmail-parent',
    provider: 'gmail',
    accountId: 'private@example.test',
    accountEmail: 'private@example.test',
    name: 'gmail',
    status: 'CONNECTED',
    teamIds: [],
  },
  {
    id: 'imessage-parent',
    integrationId: 'imessage-parent',
    provider: 'imessage',
    accountId: '',
    accountEmail: null,
    name: 'iMessage',
    status: 'CONNECTED',
    teamIds: [],
  },
];
export function mockTeams(initial: Team[] = [makeTeam()], invitations: Team[] = []) {
  const state: TeamsResponse & { contacts: TeamContact[] } = {
    teams: initial,
    invitations,
    contacts: [{ name: 'Tamy', email: 'tamara@roselabs.ai', onRose: true }],
  };
  const writes: { method: string; path: string; body: unknown }[] = [];
  server.use(
    http.get(TEAM_API, () => HttpResponse.json(state)),
    http.get(`${TEAM_API}/contacts`, () => HttpResponse.json({ contacts: state.contacts })),
    http.get(`${TEAM_API}/shareable-integrations`, () =>
      HttpResponse.json({ integrations: accounts }),
    ),
    http.post(TEAM_API, async ({ request }) => {
      const body = (await request.json()) as { name: string };
      writes.push({ method: request.method, path: '', body });
      const created = makeTeam({ id: `team-${state.teams.length + 1}`, name: body.name });
      state.teams.push(created);
      return HttpResponse.json(created, { status: 201 });
    }),
    http.patch(`${TEAM_API}/:teamId`, async ({ request, params }) => {
      const body = (await request.json()) as { name: string };
      writes.push({ method: request.method, path: `/${params.teamId}`, body });
      const team = state.teams.find((item) => item.id === params.teamId)!;
      team.name = body.name;
      return HttpResponse.json(team);
    }),
    http.post(`${TEAM_API}/:teamId/invites`, async ({ request, params }) => {
      const body = (await request.json()) as { email: string };
      writes.push({ method: request.method, path: `/${params.teamId}/invites`, body });
      const team = state.teams.find((item) => item.id === params.teamId)!;
      const contact = state.contacts.find((item) => item.email === body.email);
      const member = {
        id: `member-${team.members.length}`,
        userId: contact?.onRose ? `user-${body.email}` : null,
        name: contact?.name ?? null,
        email: body.email,
        role: 'MEMBER' as const,
        status: 'INVITED' as const,
        inviteDeliveryStatus: 'SENT' as const,
        onRose: contact?.onRose ?? false,
      };
      const existing = team.members.find((item) => item.email === body.email);
      if (existing) existing.inviteDeliveryStatus = 'SENT';
      else team.members.push(member);
      return HttpResponse.json({ member, delivery: 'sent' }, { status: 201 });
    }),
    http.post(`${TEAM_API}/:teamId/invitation`, ({ params }) => {
      const team = state.invitations.find((item) => item.id === params.teamId);
      return team
        ? HttpResponse.json(team)
        : HttpResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }),
    http.post(`${TEAM_API}/:teamId/accept`, async ({ params, request }) => {
      writes.push({
        method: request.method,
        path: `/${params.teamId}/accept`,
        body: await request.json(),
      });
      const team = state.invitations.find((item) => item.id === params.teamId)!;
      state.invitations = state.invitations.filter((item) => item.id !== team.id);
      const accepted = { ...team, role: 'MEMBER' as const, status: 'ACCEPTED' as const };
      state.teams.push(accepted);
      return HttpResponse.json(accepted);
    }),
    http.delete(`${TEAM_API}/:teamId/members/:memberId`, ({ params, request }) => {
      writes.push({
        method: request.method,
        path: `/${params.teamId}/members/${params.memberId}`,
        body: null,
      });
      const team = state.teams.find((item) => item.id === params.teamId)!;
      team.members = team.members.filter((item) => item.id !== params.memberId);
      return new HttpResponse(null, { status: 204 });
    }),
    http.all(`${TEAM_API}/:teamId/integrations/:accountId`, async ({ request, params }) => {
      const team = state.teams.find((item) => item.id === params.teamId)!;
      const account = accounts.find((item) => item.id === params.accountId)!;
      writes.push({
        method: request.method,
        path: `/${team.id}/integrations/${account.id}`,
        body: request.method === 'PUT' ? await request.json() : null,
      });
      if (request.method === 'PUT')
        team.integrationShares.push({
          id: `share-${account.id}`,
          teamId: team.id,
          integrationId: account.integrationId,
          ownerUserId: 'test-user',
          ownerName: 'Owner',
          provider: account.provider,
          accountId: account.accountId,
          accountEmail: account.accountEmail,
        });
      else
        team.integrationShares = team.integrationShares.filter(
          (share) =>
            !(
              share.integrationId === account.integrationId && share.accountId === account.accountId
            ),
        );
      return request.method === 'PUT'
        ? HttpResponse.json(team)
        : new HttpResponse(null, { status: 204 });
    }),
    http.all(`${TEAM_API}/:teamId/projects/:projectId`, async ({ request, params }) => {
      const team = state.teams.find((item) => item.id === params.teamId)!;
      writes.push({
        method: request.method,
        path: `/${team.id}/projects/${params.projectId}`,
        body: request.method === 'PUT' ? await request.json() : null,
      });
      if (request.method === 'PUT')
        team.projectShares.push({
          id: `share-${params.projectId}`,
          teamId: team.id,
          teamName: team.name,
          projectId: String(params.projectId),
          ownerUserId: 'test-user',
          ownerName: 'Owner',
          name: 'Rose',
          createdAt: team.createdAt,
        });
      else
        team.projectShares = team.projectShares.filter(
          (share) => share.projectId !== params.projectId,
        );
      return request.method === 'PUT'
        ? HttpResponse.json(team)
        : new HttpResponse(null, { status: 204 });
    }),
  );
  return { state, writes };
}
