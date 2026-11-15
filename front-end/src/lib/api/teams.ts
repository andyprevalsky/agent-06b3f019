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
  /** Display label (inbox, institution, repo, compute account, CLI name); absent on older backends. */
  label?: string | null;
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
/** `onRose` is present only for the caller's own contacts, never for an arbitrary typed address. */
export interface TeamContact {
  name: string | null;
  email: string;
  onRose?: boolean;
}
/**
 * Integrations an account row can share with a team. iPhone, browser cookies, the
 * Passwords rows and Pebble Index 01 are never shareable, so they are not listed.
 */
export type ShareableProvider =
  | 'gmail'
  | 'imessage'
  | 'whatsapp'
  | 'linkedin'
  | 'granola'
  | 'fireflies'
  | 'plaid'
  | 'github_repo'
  | 'claude_code'
  | 'gpt_code'
  | 'cli';
/**
 * One exact shareable account. `accountId`: inbox email (gmail), '' (one-row providers:
 * imessage, whatsapp, linkedin, granola/fireflies + `accountEmail`), PlaidItem.id (plaid),
 * `gh:owner/repo` (github_repo), compute account id (claude_code / gpt_code), CLI request id (cli).
 */
export interface ShareableIntegration {
  integrationId: string;
  /** Selector for PUT / DELETE /teams/:teamId/integrations/:id. */
  id: string;
  provider: string;
  accountId: string;
  accountEmail: string | null;
  /** Inbox, institution, repo, compute account email or CLI name; null when the provider has none. */
  label: string | null;
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
/** `resendUncertain` is the owner's explicit choice to resend an email that may already be delivered. */
export const inviteTeamMember = (teamId: string, email: string, resendUncertain = false) =>
  request<{
    member: TeamMember;
    delivery: 'sent' | 'failed' | 'unknown' | 'sending' | 'unavailable' | 'pending';
  }>(`/${id(teamId)}/invites`, 'POST', resendUncertain ? { email, retry: true } : { email });
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
const PROVIDER_NAMES = new Map<string, string>([
  ['gmail', 'Gmail'],
  ['imessage', 'iMessage'],
  ['whatsapp', 'WhatsApp'],
  ['linkedin', 'LinkedIn'],
  ['granola', 'Granola'],
  ['fireflies', 'Fireflies'],
  ['plaid', 'Plaid'],
  ['github_repo', 'GitHub repo'],
  ['claude_code', 'Claude Subscription'],
  ['gpt_code', 'ChatGPT Subscription'],
  ['cli', 'CLI'],
]);
/** The integration's name as its Integrations row shows it. */
export const providerDisplayName = (provider: string) =>
  PROVIDER_NAMES.get(provider.toLowerCase()) ?? provider;
type Labeled = Pick<TeamIntegrationShare, 'provider' | 'accountEmail' | 'label'>;
/** The account's own name: its label, else its email, else the integration's name. */
export const accountLabel = (account: Labeled) =>
  account.label?.trim() || account.accountEmail || providerDisplayName(account.provider);
/** "Gmail · work@example.test", "Plaid · Chase", or just "WhatsApp" for a one-account row. */
export function integrationLabel(account: Labeled): string {
  const provider = providerDisplayName(account.provider);
  const label = accountLabel(account);
  return label === provider ? provider : `${provider} · ${label}`;
}
/** Compute accounts (`claude` / `codex`) are shared as their Claude Code / Codex integration. */
export function computeShareProvider(provider: string): ShareableProvider | undefined {
  if (provider === 'claude') return 'claude_code';
  if (provider === 'codex') return 'gpt_code';
  return undefined;
}

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
