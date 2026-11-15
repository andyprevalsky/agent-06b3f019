/** Layer-safe entrypoint for explicit, current team access. Registered at boot. */
export interface TeamDataGrant {
  teamId: string;
  teamName: string;
  ownerUserId: string;
  ownerName: string | null;
  integrationId: string;
  provider: string;
  accountId: string;
  accountEmail: string | null;
  /** Display label: inbox email, institution, repo, compute account or CLI name. */
  label: string | null;
}

/** Providers whose one shareable account is the user's single Integration row (accountId ''). */
export const SINGLE_ACCOUNT_PROVIDERS = ['imessage', 'whatsapp', 'linkedin'] as const;
/** Meeting-note providers: one account per user, pinned by its account email. */
export const MEETING_NOTE_PROVIDERS = ['granola', 'fireflies'] as const;

/**
 * The exact, provider-qualified account id agents see and pass back as `account_id`.
 * Single-account providers all store accountId '' (iMessage keeps '' for compatibility),
 * so the others are named by their provider; multi-account providers use their stored id.
 */
export function agentAccountId(
  grant: Pick<TeamDataGrant, 'provider' | 'accountId' | 'accountEmail'>
): string {
  switch (grant.provider) {
    case 'gmail':
      return (grant.accountEmail ?? '').trim().toLowerCase();
    case 'imessage':
      return '';
    case 'whatsapp':
    case 'linkedin':
    case 'granola':
    case 'fireflies':
      return grant.provider;
    default:
      return grant.accountId;
  }
}

export interface SharedProjectDto {
  id: string;
  projectId: string;
  teamId: string;
  teamName: string;
  ownerUserId: string;
  ownerName: string | null;
  name: string;
  createdAt: string;
  agents: Array<{
    id: string;
    title: string | null;
    status: string;
    projectId: string;
    ownerUserId: string;
  }>;
  hasMoreAgents: boolean;
}

export interface TeamAccessFilter {
  teamId?: string;
  ownerUserId?: string;
}
export interface TeamContext {
  id: string;
  name: string;
  role: string;
}
interface TeamAccessResolver {
  resolveTeamDataAccess(userId: string, filters?: TeamAccessFilter): Promise<TeamDataGrant[]>;
  listSharedProjects(userId: string): Promise<{ projects: SharedProjectDto[] }>;
  getTeamContext(userId: string): Promise<TeamContext[]>;
}
let resolver: TeamAccessResolver | undefined;
export function registerTeamAccess(value: TeamAccessResolver): void {
  resolver = value;
}
export async function resolveTeamDataAccess(
  userId: string,
  filters?: TeamAccessFilter
): Promise<TeamDataGrant[]> {
  return resolver ? resolver.resolveTeamDataAccess(userId, filters) : [];
}
export async function listSharedProjects(
  userId: string
): Promise<{ projects: SharedProjectDto[] }> {
  return resolver ? resolver.listSharedProjects(userId) : { projects: [] };
}
export async function getTeamContext(userId: string): Promise<TeamContext[]> {
  return resolver ? resolver.getTeamContext(userId) : [];
}
