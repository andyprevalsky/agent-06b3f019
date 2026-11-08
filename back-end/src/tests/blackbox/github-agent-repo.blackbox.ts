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
import { rateLimitResponse, toResponse, type FixtureResponse } from '../helpers/fake-github';

const databaseUrl = process.env.DATABASE_URL ?? '';
assert(
  ['localhost', '127.0.0.1', '::1'].includes(new URL(databaseUrl).hostname),
  'github-agent-repo writes rows: refusing a non-local database'
);
process.env.GITHUB_AGENT_REPOS = 'on';
process.env.GITHUB_TOKEN = 'github-agent-repo-test-token';
// Blank, not deleted: database.ts's dotenv would re-add the .env value as a second token-pool member.
process.env.GITHUB_DISPATCH_TOKEN = '';
process.env.GITHUB_REPO_CREATE_MIN_INTERVAL_MS = '0';

const creates: string[] = [];
/** Repo-visibility reads that reached "GitHub", and the reply to give them. */
const visibilityReads: string[] = [];
let visibilityReply: FixtureResponse | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
  if (url.startsWith('https://api.github.com/repos/rose-test/')) {
    assert.notEqual(visibilityReply, null, 'a visibility read needs a scripted reply');
    visibilityReads.push(url);
    return toResponse(visibilityReply as FixtureResponse);
  }
  assert.equal(url, 'https://api.github.com/user/repos');
  const name = (JSON.parse(String(init?.body)) as { name: string }).name;
  creates.push(name);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return Response.json({ html_url: `https://github.com/rose-agent/${name}` });
}) as typeof fetch;

async function main(): Promise<void> {
  const { prisma } = await import('../../providers/database');
  const { checkGithubRepoAccess, ensureAgentTreeRepo, fetchGithubBranchHeadSha } =
    await import('../../providers/github');
  const { GithubRateLimitedError, resetGithubRateLimitStateForTests } =
    await import('../../providers/githubRateLimit');
  const { prepareSessionProject } = await import('../../providers/projects/session');
  await verifyHeadLookupTimeout(fetchGithubBranchHeadSha);
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

    // A rate-limited access check says so, with the reset time; it is not a denial.
    resetGithubRateLimitStateForTests();
    const resetEpochS = Math.floor(Date.now() / 1000) + 3600;
    const resetAt = new Date(resetEpochS * 1000).toISOString();
    visibilityReply = rateLimitResponse('primary', { resetEpochS });
    const limited = await checkGithubRepoAccess(userId, 'https://github.com/rose-test/limited');
    assert.equal(limited.allowed, false);
    assert.equal(limited.rateLimit?.kind, 'primary', 'the limit is reported, not swallowed');
    assert.equal(new Date(limited.rateLimit?.resetAtMs ?? 0).toISOString(), resetAt);
    assert.ok((limited.error ?? '').includes(resetAt), 'the reason carries the reset time');
    assert.doesNotMatch(
      limited.error ?? '',
      /permission|access denied/i,
      'a limit is not a denial'
    );
    assert.equal(visibilityReads.length, 1);
    await checkGithubRepoAccess(userId, 'https://github.com/rose-test/limited');
    assert.equal(visibilityReads.length, 1, 'while blocked, no call reaches GitHub');
    // A repo the owner was already granted needs no GitHub call, limit or not.
    await prisma.githubRepoAccess.create({
      data: { userId, repoUrl: 'https://github.com/rose-test/granted' },
    });
    const granted = await checkGithubRepoAccess(userId, 'https://github.com/rose-test/granted');
    assert.equal(granted.allowed, true);
    assert.equal(visibilityReads.length, 1, 'the allowlist is the cache: no GitHub call');
    // A project session cannot be cloned while the limit holds: it fails with the
    // reset time instead of cloning without credentials or into an empty checkout.
    const limitedProject = await prisma.project.create({
      data: {
        userId,
        name: `limited-${rootId}`,
        repoUrl: 'https://github.com/rose-test/limited',
        syncSalt: 'salt',
      },
    });
    await assert.rejects(
      prepareSessionProject(userId, limitedProject.id),
      (error: unknown) => error instanceof GithubRateLimitedError && error.resetAt === resetAt
    );
    assert.equal(visibilityReads.length, 1, 'the project clone check made no GitHub call');
    resetGithubRateLimitStateForTests();
    process.stdout.write(
      'PASS a rate-limited access check reports the limit and its reset time, never "access denied"\n'
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

/** Pure HTTP seam: no GitHub request or wall-clock timeout is needed. */
export async function verifyHeadLookupTimeout(
  lookup: (owner: string, repo: string, branch: string) => Promise<string | null>
): Promise<void> {
  const savedFetch = globalThis.fetch;
  const savedTimeout = AbortSignal.timeout;
  let signal: AbortSignal;
  let controller: AbortController;
  AbortSignal.timeout = (milliseconds) => {
    assert.equal(milliseconds, 10_000);
    controller = new AbortController();
    signal = controller.signal;
    return signal;
  };
  try {
    globalThis.fetch = (async (input, init) => {
      assert.equal(
        String(input),
        'https://api.github.com/repos/fixture/repo/commits/topic%2Fbranch'
      );
      assert.equal(new Headers(init?.headers).get('Accept'), 'application/vnd.github.sha');
      assert.equal(init?.signal, signal);
      return new Response('a'.repeat(40));
    }) as typeof fetch;
    assert.equal(await lookup('fixture', 'repo', 'topic/branch'), 'a'.repeat(40));
    for (const phase of ['headers', 'body']) {
      let aborted = false;
      globalThis.fetch = (async (_input, init) => {
        assert.equal(init?.signal, signal);
        const pending = new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('fixture timeout'));
          });
          queueMicrotask(() => controller.abort());
        });
        return phase === 'headers'
          ? await pending
          : ({ ok: true, text: () => pending } as Response);
      }) as typeof fetch;
      assert.equal(await lookup('fixture', 'repo', 'topic/branch'), null);
      assert(aborted, `${phase} stall must observe request cancellation`);
    }
  } finally {
    globalThis.fetch = savedFetch;
    AbortSignal.timeout = savedTimeout;
  }
}
