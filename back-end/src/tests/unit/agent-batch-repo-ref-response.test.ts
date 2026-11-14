#!/usr/bin/env tsx
/**
 * Batch create (POST /api/agents/batch) reports each child's persisted
 * Agent.githubRepoRef like single create does, so the agents service can show
 * that a for_each child kept (or explicitly selected) its connected repo.
 * A new child reports the ref resolved for it; an idempotent retry of an
 * existing row reports the stored ref, never a re-resolved one.
 */
import assert from 'node:assert/strict';

const ROSE_REF = 'gh:rose-ai-labs/rose';
const OTHER_REF = 'gh:acme/other';

async function main(): Promise<void> {
  const { batchAgentResults } = await import('../../domains/agents/agentProject');

  const bodies = ['new', 'none', 'existing', 'pending'].map((agent_id) => ({
    agent_id,
    goal: `goal ${agent_id}`,
  })) as Parameters<typeof batchAgentResults>[0];
  const started = (agent_id: string) => ({
    agent_id,
    project_id: null,
    folder_id: null,
    status: 'STARTING_UP' as const,
    temporal_workflow_id: agent_id,
    goal: `goal ${agent_id}`,
  });
  const stored = (id: string, githubRepoRef: string | null) => ({
    id,
    projectId: null,
    folderId: null,
    githubRepoRef,
    status: 'ACTIVE',
    temporalWorkflowId: id,
    goal: `goal ${id}`,
    model: 'rose-labs/rose-1-flash',
  });

  const results = batchAgentResults(
    bodies,
    new Map([
      ['new', started('new')],
      ['none', started('none')],
      ['pending', started('pending')],
    ]),
    new Map([
      ['existing', stored('existing', ROSE_REF)],
      ['pending', stored('pending', ROSE_REF)],
    ]),
    new Map([
      ['new', { githubRepoRef: ROSE_REF }],
      ['none', {}],
      ['existing', { githubRepoRef: OTHER_REF }],
      ['pending', { githubRepoRef: OTHER_REF }],
    ])
  );

  assert.deepEqual(
    results.map((r) => [r.agent_id, r.github_repo_ref]),
    [
      ['new', ROSE_REF],
      ['none', null],
      ['existing', ROSE_REF],
      ['pending', ROSE_REF],
    ]
  );
  assert.equal(results[2].already_existed, true);
  assert.equal(results[2].status, 'ACTIVE');
  assert.equal(results[3].status, 'STARTING_UP');
  process.stdout.write('agent-batch-repo-ref-response: ok\n');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
