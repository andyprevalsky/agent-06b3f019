/** Shared local-only HTTP fixtures and cleanup for the Teams blackbox suite. */
import { apiKeyHeaders, call, expectStatus } from './projects-harness';
import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import { prisma } from '../../providers/database';

const owners: string[] = [];
export async function user(name = 'User') {
  const userId = randomUUID();
  const email = `teams-${userId}@example.test`;
  await prisma.user.create({ data: { userId, email, name, isAnonymous: false } });
  owners.push(userId);
  return { userId, email };
}
export type User = Awaited<ReturnType<typeof user>>;
export async function request(u: User, path: string, method = 'GET', body?: unknown, status = 200) {
  const res = await call(`/api/teams${path}`, { method, body, headers: apiKeyHeaders(u.userId) });
  expectStatus(res, status, `${method} ${path}`);
  return res.data;
}
export async function team(u: User, name = 'Team') {
  return request(u, '', 'POST', { name }, 201);
}
export async function join(owner: User, member: User, id: string) {
  await request(owner, `/${id}/invites`, 'POST', { email: member.email }, 201);
  return request(member, `/${id}/accept`, 'POST', {});
}
export async function gmail(u: User) {
  const integration = await prisma.integration.create({
    data: {
      userId: u.userId,
      name: 'gmail',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
    },
  });
  const credentials = await Promise.all(
    ['work', 'private'].map((prefix) =>
      prisma.emailIntegrationCredential.create({
        data: {
          userId: u.userId,
          integrationId: integration.id,
          provider: 'GMAIL',
          email: `${prefix}-${u.email}`,
          state: 'connected',
        },
      })
    )
  );
  return { integration, credentials };
}
after(async () => {
  await prisma.agent.deleteMany({ where: { userId: { in: owners } } });
  await prisma.integration.deleteMany({ where: { userId: { in: owners } } });
  await prisma.person.deleteMany({ where: { userId: { in: owners } } });
  await prisma.user.deleteMany({ where: { userId: { in: owners } } });
  await prisma.$disconnect();
});
