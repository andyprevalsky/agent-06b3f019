#!/usr/bin/env tsx
/**
 * Codex createSession resolves the agent's project before it resolves a repo.
 * That lookup is one more database read on every session, including for agents
 * with no project at all. A transient failure there must not fail the session:
 * it reads as "no project" and the agent tree's repo is used, as it was before
 * projects existed. A successful lookup still names the agent's (or its root's)
 * project.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

type AgentRow = {
  githubRepoUrl: string | null;
  userId: string;
  busId: string | null;
  projectId: string | null;
};

const agentRows = new Map<string, AgentRow>();
const lookups: string[] = [];
let failingLookups = new Set<string>();
const projectIdsSeen: Array<string | undefined> = [];
const treeRepoRequests: string[] = [];
const spawnRequests: Array<{ repoUrl: string | null }> = [];

const lookup = async (agentId: string): Promise<AgentRow | null> => {
  lookups.push(agentId);
  if (failingLookups.has(agentId)) throw new Error(`database unavailable for ${agentId}`);
  return agentRows.get(agentId) ?? null;
};

async function main(): Promise<void> {
  await mock.module('../../domains/codex-code/repo', {
    namedExports: {
      findAgentGithubInfo: lookup,
      findRootAgentGithubInfo: lookup,
      findAgentSpeed: async () => 'standard',
      findSessionsByAgent: async () => [],
      persistSessionOutput: async () => {},
      markSessionServedByAzure: async () => {},
      findSessionById: async () => null,
    },
  });
  await mock.module('../../providers/projects/session', {
    namedExports: {
      resolveSessionProject: async (_userId: string | undefined, projectId: string | undefined) => {
        projectIdsSeen.push(projectId);
        return null;
      },
    },
  });
  await mock.module('../../providers/github', {
    namedExports: {
      ensureAgentTreeRepo: async (agentId: string) => {
        treeRepoRequests.push(agentId);
        return 'https://github.com/rose-test/tree-repo';
      },
      checkGithubRepoAccess: async (_userId: string, url: string) => ({
        allowed: true,
        normalizedUrl: url,
      }),
    },
  });
  await mock.module('../../providers/codeSessions/spawn', {
    namedExports: {
      createWithCodeSession: async (request: { repoUrl: string | null }) => {
        spawnRequests.push({ repoUrl: request.repoUrl });
        return {
          session: {
            taskId: 'task-1',
            sandboxId: 'sandbox-1',
            wsUrl: 'wss://example.invalid/ws',
            uploadedFiles: [],
            projectRestore: null,
            previewUrl: null,
          },
          fields: {},
        };
      },
    },
  });
  const { createSession } = await import('../../domains/codex-code/service');

  const reset = (): void => {
    lookups.length = 0;
    projectIdsSeen.length = 0;
    treeRepoRequests.length = 0;
    spawnRequests.length = 0;
    failingLookups = new Set();
    agentRows.clear();
  };
  const params = (agentId: string) => ({
    agent_id: agentId,
    goal: 'write answer.txt',
    user_id: 'user-1',
  });

  // A failed lookup must not fail the session: no project, tree repo as before.
  reset();
  failingLookups = new Set(['agent-lookup-down']);
  const created = await createSession(params('agent-lookup-down'));
  assert.equal(created.task_id, 'task-1');
  assert.deepEqual(projectIdsSeen, [undefined], 'a failed lookup reads as "no project"');
  assert.deepEqual(treeRepoRequests, ['agent-lookup-down'], 'the tree repo fallback runs');
  assert.deepEqual(spawnRequests, [{ repoUrl: 'https://github.com/rose-test/tree-repo' }]);
  assert.equal(created.github_repo_url, 'https://github.com/rose-test/tree-repo');

  // The root lookup of a child failing degrades the same way.
  reset();
  agentRows.set('child', { githubRepoUrl: null, userId: 'user-1', busId: 'root', projectId: null });
  failingLookups = new Set(['root']);
  await createSession(params('child'));
  assert.deepEqual(projectIdsSeen, [undefined]);
  assert.deepEqual(treeRepoRequests, ['child']);

  // A successful lookup is unchanged: the agent's own project, else its root's.
  reset();
  agentRows.set('own', {
    githubRepoUrl: null,
    userId: 'user-1',
    busId: 'own',
    projectId: 'project-own',
  });
  await createSession(params('own'));
  assert.deepEqual(projectIdsSeen, ['project-own']);
  reset();
  agentRows.set('kid', { githubRepoUrl: null, userId: 'user-1', busId: 'top', projectId: null });
  agentRows.set('top', {
    githubRepoUrl: null,
    userId: 'user-1',
    busId: 'top',
    projectId: 'project-top',
  });
  await createSession(params('kid'));
  assert.deepEqual(projectIdsSeen, ['project-top']);

  process.stdout.write('codex-code project lookup: all cases passed\n');
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
