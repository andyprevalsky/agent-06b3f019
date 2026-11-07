#!/usr/bin/env tsx
/**
 * The chat router and generator read the agent's project once per turn, in the
 * same Promise.all as the turn's messages. That read is optional prompt
 * enrichment: a transient database failure must read as "no project" (a Home
 * chat) instead of failing the whole turn. A successful read is unchanged.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

let failing = false;
let row: { project: { name: string; repoUrl: string | null; defaultBranch: string } | null } | null =
  null;
const lookups: string[] = [];

async function main(): Promise<void> {
  await mock.module('../../providers/database', {
    namedExports: {
      prisma: {
        agent: {
          findUnique: async (args: { where: { id: string } }) => {
            lookups.push(args.where.id);
            if (failing) throw new Error('database unavailable');
            return row;
          },
        },
      },
    },
  });
  const { loadRouterProjectContext } = await import('../../providers/chat/projectContext');

  failing = true;
  assert.equal(await loadRouterProjectContext('agent-down'), '', 'a failed lookup reads as Home');
  assert.deepEqual(lookups, ['agent-down']);

  failing = false;
  row = null;
  assert.equal(await loadRouterProjectContext('agent-missing'), '');
  row = { project: null };
  assert.equal(await loadRouterProjectContext('agent-home'), '');
  row = {
    project: { name: 'Rose', repoUrl: 'https://github.com/Rose-Ai-Labs/rose', defaultBranch: 'main' },
  };
  assert.match(
    await loadRouterProjectContext('agent-project'),
    /^## Project\nThis chat is in the user's project "Rose" \(GitHub repo Rose-Ai-Labs\/rose, default branch main\)/
  );

  process.stdout.write('chat project-context lookup: all cases passed\n');
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
