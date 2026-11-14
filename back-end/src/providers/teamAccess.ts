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
