#!/usr/bin/env tsx
/**
 * Regression: "whenever I create a new rose agent, it loses the ref to the gh
 * project". A new agent (root via the real createAgent, sub-agents and batches
 * via the same resolver) persists the canonical repo ref of its project /
 * integration; explicit refs win over inherited ones; code-session launch
 * honours the persisted ref; the tree repo is the connected repo, not a fresh
 * auto-created `agent-<id>` workspace.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';

const ROSE_URL = 'https://github.com/Rose-Ai-Labs/rose';
const ROSE_REF = 'gh:rose-ai-labs/rose';
const TOOL_URL = 'https://github.com/public-owner/tool';
const TOOL_REF = 'gh:public-owner/tool';

async function main(): Promise<void> {
  const unsafe = nonLocalDatabaseReason(process.env.DATABASE_URL);
  assert.equal(unsafe, null, `Regression tests require a local database: ${unsafe}`);
  process.env.GITHUB_AGENT_REPOS = 'off';
  const { prisma } = await import('../../providers/database');
  const { createAgent } = await import('../../domains/agents/agentLifecycleService');
  const { createAgentSchema } = await import('../../domains/agents/types');
  const { AgentProjectNotFoundError } = await import('../../domains/agents/agentProject');
  const { resolveBatchRepoFields, resolveCreateRepoFields } =
    await import('../../domains/agents/agentProject');
  const { resolveCodeSessionRepoOverride, GithubRepoRefNotFoundError } =
    await import('../../providers/githubRepos/resolve');
  const { ensureAgentTreeRepo } = await import('../../providers/github');
  const { connectGithubRepo } = await import('../../providers/githubRepos/store');
  const { githubRepoIdentity } = await import('../../providers/githubRepos/refs');

  const userId = randomUUID();
  await prisma.user.create({ data: { userId } });
  try {
    // The connected Rose project (legacy: repo + grant, not yet imported) and a
    // folder connected to a second repo through the integration.
    const rose = await prisma.project.create({
      data: { userId, name: 'Rose', repoUrl: ROSE_URL, syncSalt: 'a' },
    });
    const toolFolder = await prisma.project.create({
      data: { userId, name: 'Tool', repoUrl: TOOL_URL, syncSalt: 'b' },
    });
    await prisma.githubRepoAccess.createMany({
      data: [
        { userId, repoUrl: ROSE_URL },
        { userId, repoUrl: TOOL_URL },
      ],
    });
    await connectGithubRepo({
      userId,
      identity: githubRepoIdentity(TOOL_URL)!,
      defaultBranch: 'main',
      connectedRoseProjectRef: toolFolder.id,
      source: 'connect',
    });

    const createRoot = (extra: Record<string, unknown>) =>
      createAgent(
        createAgentSchema.parse({ goal: 'repo ref regression', model: 'local/test', ...extra }),
        userId,
        true,
        null,
        false,
        { externalExecution: true }
      );
    const row = (id: string) =>
      prisma.agent.findUniqueOrThrow({
        where: { id },
        select: { githubRepoRef: true, githubRepoUrl: true, projectId: true },
      });

    // 1. New root in the Rose project keeps the project's repo ref (legacy import on demand).
    const inRose = await createRoot({ project_id: rose.id });
    assert.equal(inRose.github_repo_ref, ROSE_REF, 'create response carries the ref');
    assert.deepEqual(await row(inRose.agent_id), {
      githubRepoRef: ROSE_REF,
      githubRepoUrl: null,
      projectId: rose.id,
    });

    // 2. Explicit ref (any spelling) wins over the project's repo and sets the clone URL.
    const overridden = await createRoot({
      project_id: rose.id,
      github_repo_ref: `${TOOL_URL}.git`,
    });
    assert.deepEqual(await row(overridden.agent_id), {
      githubRepoRef: TOOL_REF,
      githubRepoUrl: TOOL_URL,
      projectId: rose.id,
    });

    // 3. Home root with an explicit ref: the tree repo IS the connected repo
    //    (before: a fresh agent-<id> workspace repo, or none).
    const home = await createRoot({ github_repo_ref: ROSE_REF });
    assert.deepEqual(await row(home.agent_id), {
      githubRepoRef: ROSE_REF,
      githubRepoUrl: ROSE_URL,
      projectId: null,
    });
    assert.equal(await ensureAgentTreeRepo(home.agent_id), ROSE_URL);

    // 4. Explicit null opts out; an unconnected or foreign ref is rejected (404 path).
    const none = await createRoot({ project_id: rose.id, github_repo_ref: null });
    assert.equal((await row(none.agent_id)).githubRepoRef, null);
    await assert.rejects(
      createRoot({ github_repo_ref: 'https://github.com/private-owner/secret' }),
      (error: unknown) => error instanceof AgentProjectNotFoundError
    );

    // 5. Sub-agents inherit the parent's ref; explicit project / ref win over it.
    const child = (extra: Record<string, unknown>) =>
      createAgentSchema.parse({
        goal: 'child',
        model: 'local/test',
        parent_agent_id: overridden.agent_id,
        parent_workflow_id: overridden.agent_id,
        agent_id: randomUUID(),
        ...extra,
      });
    assert.deepEqual(
      await resolveCreateRepoFields(child({}), userId, {
        projectId: rose.id,
        explicitProject: false,
      }),
      { githubRepoRef: TOOL_REF, githubRepoUrl: TOOL_URL },
      'inherited from the parent (its override), not re-derived from the project'
    );
    assert.deepEqual(
      await resolveCreateRepoFields(child({ project_id: rose.id }), userId, {
        projectId: rose.id,
        explicitProject: true,
      }),
      { githubRepoRef: ROSE_REF },
      'explicit project placement wins over the inherited ref'
    );
    const childOfRose = createAgentSchema.parse({
      goal: 'child',
      model: 'local/test',
      parent_agent_id: inRose.agent_id,
      parent_workflow_id: inRose.agent_id,
      agent_id: randomUUID(),
    });
    const explicitChild = child({ github_repo_ref: ROSE_REF });
    const batch = await resolveBatchRepoFields(
      [
        { ...childOfRose, project_id: rose.id },
        { ...explicitChild, project_id: rose.id },
      ],
      userId,
      new Set()
    );
    assert.deepEqual(batch.get(childOfRose.agent_id!), { githubRepoRef: ROSE_REF });
    assert.deepEqual(batch.get(explicitChild.agent_id!), {
      githubRepoRef: ROSE_REF,
      githubRepoUrl: ROSE_URL,
    });

    // 6. Code-session launch: the persisted override replaces the project restore,
    //    a matching ref keeps it, an explicit spawn ref is permission-checked.
    assert.deepEqual(
      await resolveCodeSessionRepoOverride(userId, { agentRepoRef: TOOL_REF, projectId: rose.id }),
      { repoUrl: TOOL_URL, canonicalRef: TOOL_REF, skipProject: true }
    );
    assert.equal(
      await resolveCodeSessionRepoOverride(userId, { agentRepoRef: ROSE_REF, projectId: rose.id }),
      null,
      'same repo as the project: the project restore owns the checkout'
    );
    assert.deepEqual(
      await resolveCodeSessionRepoOverride(userId, {
        githubRepoRef: rose.id,
        projectId: toolFolder.id,
      }),
      { repoUrl: ROSE_URL, canonicalRef: ROSE_REF, skipProject: true },
      'legacy project id as an explicit spawn ref'
    );
    await assert.rejects(
      resolveCodeSessionRepoOverride(randomUUID(), { githubRepoRef: ROSE_REF }),
      (error: unknown) => error instanceof GithubRepoRefNotFoundError,
      'another user cannot launch on this repo'
    );
  } finally {
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.githubRepoAccess.deleteMany({ where: { userId } });
    await prisma.integration.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  }
  process.stdout.write('agent-repo-ref-propagation: ok\n');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
