/** Pure DTO assembly: index shared rows once and render each team without further reads. */
import type * as repo from './repo';
import type { MemberDto, SharedProjectDto, TeamDataGrant } from './types';

type TeamDetails = NonNullable<Awaited<ReturnType<typeof repo.teamDetails>>>;
type EmailUser = Awaited<ReturnType<typeof repo.usersForEmails>>[number];

export function memberDto(member: {
  id: string;
  userId: string | null;
  email: string | null;
  role: string;
  status: string;
  inviteDeliveryStatus: string;
  user: { name: string | null } | null;
}): MemberDto {
  return {
    id: member.id,
    userId: member.userId,
    email: member.email,
    role: member.role,
    status: member.status,
    name: member.user?.name ?? null,
    onRose: member.userId !== null && member.user !== null,
    inviteDeliveryStatus: member.inviteDeliveryStatus,
  };
}

function groupByTeam<T extends { teamId: string }>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.teamId);
    if (group === undefined) groups.set(row.teamId, [row]);
    else group.push(row);
  }
  return groups;
}

export function indexTeamPresentation(
  grants: TeamDataGrant[],
  projects: SharedProjectDto[],
  users: EmailUser[]
) {
  const emailUsers = new Map<string, EmailUser | null>();
  for (const user of users) {
    if (user.email === null) continue;
    const email = user.email.trim().toLowerCase();
    // Multiple accounts at an address remain ambiguous, including across teams.
    emailUsers.set(email, emailUsers.has(email) ? null : user);
  }
  return { grants: groupByTeam(grants), projects: groupByTeam(projects), emailUsers };
}

export function teamDto(
  team: TeamDetails,
  role: string,
  indexed: ReturnType<typeof indexTeamPresentation>
) {
  return {
    id: team.id,
    name: team.name,
    ownerUserId: team.ownerUserId,
    createdAt: team.createdAt.toISOString(),
    updatedAt: team.updatedAt.toISOString(),
    role,
    status: 'ACCEPTED',
    members: team.members.map((member) => {
      const dto = memberDto(member);
      const match = member.email === null ? undefined : indexed.emailUsers.get(member.email);
      return {
        ...dto,
        onRose: dto.onRose || (match !== undefined && match !== null),
        name: dto.name ?? match?.name ?? null,
      };
    }),
    integrationShares: (indexed.grants.get(team.id) ?? []).map((grant) => ({
      ...grant,
      id: `${grant.integrationId}:${grant.accountId}`,
    })),
    projectShares: indexed.projects.get(team.id) ?? [],
  };
}
