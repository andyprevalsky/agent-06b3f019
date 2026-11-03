/**
 * An agent tree's GitHub repo is created once, on its first code session
 * (ensureAgentTreeRepo), never per chat agent:
 *  - concurrent sessions in one tree share one create, which is persisted on
 *    the root and granted to the owner;
 *  - later sessions reuse it without calling GitHub;
 *  - a tree bound to a project gets no repo (the project owns the checkout).
 * GitHub is a fetch stub; the database must be the local one.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL ?? '';
assert(
  ['localhost', '127.0.0.1', '::1'].includes(new URL(databaseUrl).hostname),
  'github-agent-repo writes rows: refusing a non-local database'
);
process.env.GITHUB_AGENT_REPOS = 'on';
process.env.GITHUB_TOKEN = 'github-agent-repo-test-token';
delete process.env.GITHUB_DISPATCH_TOKEN;
process.env.GITHUB_REPO_CREATE_MIN_INTERVAL_MS = '0';

const creates: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
  assert.equal(url, 'https://api.github.com/user/repos');
  const name = (JSON.parse(String(init?.body)) as { name: string }).name;
  creates.push(name);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return Response.json({ html_url: `https://github.com/rose-agent/${name}` });
}) as typeof fetch;

async function main(): Promise<void> {
  const { prisma } = await import('../../providers/database');
  const { ensureAgentTreeRepo } = await import('../../providers/github');
  const userId = `gh-repo-${crypto.randomUUID()}`;
  const rootId = crypto.randomUUID();
  const childId = crypto.randomUUID();
  const projectRootId = crypto.randomUUID();
  await prisma.user.create({ data: { userId } });
  try {
    await prisma.agent.create({
      data: { id: rootId, userId, goal: 'chat root', busId: rootId, status: 'ACTIVE' },
    });
    await prisma.agent.create({
      data: {
        id: childId,
        userId,
        goal: 'code child',
        parentAgentId: rootId,
        busId: rootId,
        status: 'ACTIVE',
      },
    });
    const expected = `https://github.com/rose-agent/agent-${rootId.substring(0, 8)}`;

    // Concurrent first code sessions in one tree: one create.
    const urls = await Promise.all([ensureAgentTreeRepo(childId), ensureAgentTreeRepo(rootId)]);
    assert.deepEqual(urls, [expected, expected]);
    assert.deepEqual(creates, [`agent-${rootId.substring(0, 8)}`]);
    const root = await prisma.agent.findUniqueOrThrow({ where: { id: rootId } });
    assert.equal(root.githubRepoUrl, expected, 'the repo is persisted on the root');
    const access = await prisma.githubRepoAccess.count({ where: { userId, repoUrl: expected } });
    assert.equal(access, 1, 'the owner is granted the repo');

    // Later sessions reuse it.
    assert.equal(await ensureAgentTreeRepo(childId), expected);
    assert.equal(creates.length, 1, 'an existing repo must not be created again');

    // A project-bound tree gets no repo.
    const project = await prisma.project.create({
      data: { userId, name: `p-${projectRootId}`, syncSalt: 'salt' },
    });
    await prisma.agent.create({
      data: {
        id: projectRootId,
        userId,
        goal: 'project root',
        busId: projectRootId,
        projectId: project.id,
        status: 'ACTIVE',
      },
    });
    assert.equal(await ensureAgentTreeRepo(projectRootId), undefined);
    assert.equal(creates.length, 1);
    process.stdout.write(
      'PASS an agent tree gets one GitHub repo on its first code session, reused after, none for projects\n'
    );
  } finally {
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.githubRepoAccess.deleteMany({ where: { userId } });
    await prisma.project.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { userId } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
