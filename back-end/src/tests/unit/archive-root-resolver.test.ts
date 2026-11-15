#!/usr/bin/env tsx
/**
 * archiveRootResolver: a root is cached only once the walk proves it, and a
 * failed lookup never binds the acting agent as its own root.
 *
 *   C0 → C1 → … → C10 (legacy, no busId) ─► walk stops at the depth bound ─► NOT cached
 *   A ↔ B parent cycle                      ─► walk stops, NOT cached, no endless loop
 *   child (busId root)                       ─► root, cached (one lookup)
 *   archiveBindingFor(child), lookup throws  ─► retried, then REJECTS (never child-as-root)
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  __resetArchiveRootCache,
  archiveBindingFor,
  resolveArchiveRoot,
} from '../../providers/archiveRootResolver';

type Row = { busId: string | null; parentAgentId: string | null } | null;

async function main(): Promise<void> {
  const originalFindUnique = prisma.agent.findUnique;
  let rows = new Map<string, Row>();
  let lookups = 0;
  let failLookups = 0;
  Object.assign(prisma.agent, {
    findUnique: async (args: { where: { id?: string } }) => {
      lookups += 1;
      if (failLookups > 0) {
        failLookups -= 1;
        throw new Error('database unavailable');
      }
      return rows.get(args.where.id ?? '') ?? null;
    },
  });
  try {
    // (1) A legacy chain deeper than the walk bound is not cached as its root.
    __resetArchiveRootCache();
    const chain = Array.from({ length: 11 }, () => randomUUID());
    rows = new Map(
      chain.map((id, index): [string, Row] => [
        id,
        { busId: null, parentAgentId: chain[index + 1] ?? null },
      ])
    );
    const partial = await resolveArchiveRoot(chain[0]);
    assert.notEqual(partial, chain[10], 'the bounded walk stops before the real root');
    lookups = 0;
    await resolveArchiveRoot(chain[0]);
    assert(lookups > 0, 'an incomplete walk is re-resolved, not served from the cache');

    // (2) A parent cycle terminates and is not cached.
    __resetArchiveRootCache();
    const [a, b] = [randomUUID(), randomUUID()];
    rows = new Map<string, Row>([
      [a, { busId: null, parentAgentId: b }],
      [b, { busId: null, parentAgentId: a }],
    ]);
    lookups = 0;
    await resolveArchiveRoot(a);
    assert(lookups <= 2, `a parent cycle stops at the first revisit (lookups=${lookups})`);
    lookups = 0;
    await resolveArchiveRoot(a);
    assert(lookups > 0, 'a cyclic walk is not cached');

    // (3) A proven root (busId) is cached: the second resolution does no lookup.
    __resetArchiveRootCache();
    const [root, child] = [randomUUID(), randomUUID()];
    rows = new Map<string, Row>([
      [child, { busId: root, parentAgentId: root }],
      [root, { busId: root, parentAgentId: null }],
    ]);
    assert.equal(await resolveArchiveRoot(child), root);
    lookups = 0;
    assert.equal(await resolveArchiveRoot(child), root);
    assert.equal(lookups, 0, 'a proven root is cached');

    // (4) A transient lookup failure is retried and still binds the real root.
    __resetArchiveRootCache();
    failLookups = 1;
    assert.deepEqual(await archiveBindingFor({ agentId: child }), {
      agent_id: child,
      root_agent_id: root,
    });

    // (5) A persistent failure rejects: the child is never returned as its own root.
    __resetArchiveRootCache();
    failLookups = Number.MAX_SAFE_INTEGER;
    await assert.rejects(archiveBindingFor({ agentId: child }), /database unavailable/);
    failLookups = 0;
    process.stdout.write('archive-root-resolver: all checks passed\n');
  } finally {
    Object.assign(prisma.agent, { findUnique: originalFindUnique });
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
