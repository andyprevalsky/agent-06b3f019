/** Authenticated Teams REST client; all writes address an exact team/resource. */
import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export type InviteDeliveryStatus =
  'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'UNKNOWN' | 'UNAVAILABLE';

export interface TeamMember {
  id: string;
  userId: string | null;
  email: string | null;
  name: string | null;
  role: 'OWNER' | 'MEMBER';
  status: 'ACCEPTED' | 'INVITED';
  onRose: boolean;
  inviteDeliveryStatus?: InviteDeliveryStatus;
}
export interface TeamIntegrationShare {
  id: string;
  teamId: string;
  integrationId: string;
  ownerUserId: string;
  ownerName: string | null;
  provider: string;
  accountId: string;
  accountEmail: string | null;
}
export interface SharedTeamProject {
  id: string;
  projectId: string;
  teamId: string;
  teamName: string;
  ownerUserId: string;
  ownerName: string | null;
  name: string;
  createdAt: string;
}
export interface Team {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
  role: 'OWNER' | 'MEMBER';
  status: 'ACCEPTED' | 'INVITED';
  members: TeamMember[];
  integrationShares: TeamIntegrationShare[];
  projectShares: SharedTeamProject[];
}
export interface TeamContact {
  name: string | null;
  email: string;
  onRose: boolean;
  userId: string | null;
}
export interface ShareableIntegration {
  integrationId: string;
  id: string;
  provider: string;
  accountId: string;
  accountEmail: string | null;
  name: string;
  status: string;
  teamIds: string[];
}
export interface TeamsResponse {
  teams: Team[];
  invitations: Team[];
}

async function request<T>(
  path: string,
  method = 'GET',
  body?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API_BASE_WITH_PATH}/teams${path}`, {
    method,
    headers: getAuthHeaders(),
    signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Teams request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
const id = encodeURIComponent;
/** Lists render inside other screens; an unexpected body is a load error, not a crash. */
function requireArrays<T extends object>(data: T, keys: readonly (keyof T)[]): T {
  if (!keys.every((key) => Array.isArray(data?.[key])))
    throw new Error('Unexpected Teams response. Try again later.');
  return data;
}
export const fetchTeams = async (signal?: AbortSignal) =>
  requireArrays(await request<TeamsResponse>('', 'GET', undefined, signal), [
    'teams',
    'invitations',
  ]);
export const createTeam = (name: string) => request<Team>('', 'POST', { name });
export const renameTeam = (teamId: string, name: string) =>
  request<Team>(`/${id(teamId)}`, 'PATCH', { name });
export const fetchTeamContacts = (query: string, signal?: AbortSignal) =>
  request<{ contacts: TeamContact[] }>(`/contacts?q=${id(query)}`, 'GET', undefined, signal);
export const inviteTeamMember = (teamId: string, email: string) =>
  request<{
    member: TeamMember;
    delivery: 'sent' | 'failed' | 'unknown' | 'sending' | 'unavailable' | 'pending';
  }>(`/${id(teamId)}/invites`, 'POST', { email });
export const previewTeamInvitation = (teamId: string, token: string, signal?: AbortSignal) =>
  request<Team>(`/${id(teamId)}/invitation`, 'POST', { token }, signal);
export const acceptTeamInvitation = (teamId: string, token: string) =>
  request<Team>(`/${id(teamId)}/accept`, 'POST', { token });
export const removeTeamMember = (teamId: string, memberId: string) =>
  request<void>(`/${id(teamId)}/members/${id(memberId)}`, 'DELETE');
export const fetchShareableIntegrations = async (signal?: AbortSignal) =>
  requireArrays(
    await request<{ integrations: ShareableIntegration[] }>(
      '/shareable-integrations',
      'GET',
      undefined,
      signal,
    ),
    ['integrations'],
  );
export const setTeamIntegration = (teamId: string, integrationId: string, shared: boolean) =>
  request<Team | void>(
    `/${id(teamId)}/integrations/${id(integrationId)}`,
    shared ? 'PUT' : 'DELETE',
    shared ? {} : undefined,
  );
export const setTeamProject = (teamId: string, projectId: string, shared: boolean) =>
  request<Team | void>(
    `/${id(teamId)}/projects/${id(projectId)}`,
    shared ? 'PUT' : 'DELETE',
    shared ? {} : undefined,
  );

/** Match the parent integration AND account; sibling inboxes never inherit an opt-in. */
export function isAccountShared(team: Team, account: ShareableIntegration): boolean {
  return team.integrationShares.some(
    (share) =>
      share.integrationId === account.integrationId && share.accountId === account.accountId,
  );
}
export const integrationLabel = (account: ShareableIntegration) =>
  `${account.provider.toLowerCase() === 'imessage' ? 'iMessage' : account.provider} · ${account.accountEmail || account.accountId || account.name}`;

export function inviteDeliveryLabel(status: InviteDeliveryStatus | undefined): string {
  switch (status) {
    case 'SENT':
      return 'Email sent';
    case 'FAILED':
      return 'Email delivery failed';
    case 'UNKNOWN':
      return 'Email delivery unconfirmed';
    case 'UNAVAILABLE':
      return 'Email delivery unavailable';
    case 'SENDING':
      return 'Sending email';
    default:
      return 'Email pending';
  }
}
