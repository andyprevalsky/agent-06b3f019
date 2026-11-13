#!/usr/bin/env tsx
/** Explicit, repeatable first-team setup. Dry-run by default; never guesses identity. */
import { parseArgs } from 'node:util';

async function main() {
  const { values } = parseArgs({
    options: {
      'database-url': { type: 'string' },
      'owner-user-id': { type: 'string' },
      'owner-email': { type: 'string' },
      'owner-name': { type: 'string' },
      name: { type: 'string', default: 'Rose Labs' },
      'invite-email': { type: 'string', default: 'tamara@roselabs.ai' },
      apply: { type: 'boolean', default: false },
    },
  });
  const target = values['database-url'];
  const ownerUserId = values['owner-user-id'];
  const ownerEmail = values['owner-email'];
  if (!target || !ownerUserId)
    throw new Error(
      'Require --database-url and --owner-user-id; --owner-email/--owner-name are optional identity assertions. Default is dry-run. --apply creates the team and sends its invitation.'
    );
  const url = new URL(target);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('Expected explicit Postgres database URL');
  process.env.DATABASE_URL = target;
  process.env.DIRECT_URL = target;
  const { prisma } = await import('../src/providers/database');
  const service = await import('../src/domains/teams/service');
  const { normalizedEmail, teamName } = await import('../src/domains/teams/types');
  try {
    const owner = await prisma.user.findUnique({
      where: { userId: ownerUserId },
      select: { userId: true, email: true, name: true, isAnonymous: true },
    });
    if (
      !owner ||
      owner.isAnonymous ||
      (ownerEmail !== undefined &&
        owner.email?.trim().toLowerCase() !== normalizedEmail(ownerEmail)) ||
      (values['owner-name'] !== undefined && owner?.name !== values['owner-name'])
    )
      throw new Error('Owner identity does not match this database');
    const name = teamName(values.name);
    const email = normalizedEmail(values['invite-email']);
    if (!values.apply) {
      const matches = await prisma.team.findMany({
        where: { ownerUserId, name },
        select: { id: true },
        take: 2,
      });
      if (matches.length > 1) throw new Error('More than one matching team; select explicitly');
      process.stdout.write(
        JSON.stringify({
          mode: 'dry-run',
          databaseHost: url.hostname,
          databaseName: url.pathname.slice(1),
          ownerUserId,
          ownerName: owner.name,
          name,
          inviteEmail: email,
          existingTeamId: matches[0]?.id ?? null,
          action:
            'Create or reuse team, then invite; existing sent/unknown delivery is not repeated',
          shares: [],
        }) + '\n'
      );
      return;
    }
    const result = await service.bootstrapTeam(ownerUserId, ownerEmail, name, email);
    process.stdout.write(
      JSON.stringify({
        teamId: result.team.id,
        name: result.team.name,
        inviteEmail: email,
        delivery: result.invitation.delivery,
        membershipStatus: result.invitation.member.status,
      }) + '\n'
    );
    if (!['sent', 'sending'].includes(result.invitation.delivery)) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
