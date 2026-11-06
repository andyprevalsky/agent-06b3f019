#!/usr/bin/env tsx
// Pure rules of the one-time orphan reaper: every guard has its own fixture, so
// removing any guard flips a case below.
import assert from 'node:assert/strict';
import {
  decideOrphan,
  type OrphanCandidate,
  type ProdReferences,
} from '../../providers/codeSessions/orphanSandboxEligibility';

const now = new Date('2026-11-06T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
const refs: ProdReferences = {
  sandboxIds: new Set(['sb-ref']),
  codeSessionIds: new Set(['cs-live']),
  agentIds: new Set(['agent-live']),
};
const sb = (
  over: Partial<OrphanCandidate> & { metadata?: Record<string, string> }
): OrphanCandidate => ({
  sandboxId: 'sb-x',
  state: 'paused',
  startedAt: hoursAgo(200),
  metadata: {},
  ...over,
});
const decide = (s: OrphanCandidate) => decideOrphan(s, refs, now);

// eligible
assert.equal(decide(sb({})).bucket, 'untagged-over-24h');
assert.equal(decide(sb({ metadata: { createRequestId: 'r' } })).eligible, true);
assert.equal(
  decide(sb({ metadata: { roseOrigin: 'host:boxes', roseStack: 's' } })).bucket,
  'host-tagged-over-72h'
);

// state guard
assert.equal(decide(sb({ state: 'running' })).bucket, 'kept-running');
// prod reference guards (id + each metadata link)
assert.equal(decide(sb({ sandboxId: 'sb-ref' })).bucket, 'kept-by-reference');
assert.equal(decide(sb({ metadata: { codeSessionId: 'cs-live' } })).bucket, 'kept-by-reference');
assert.equal(decide(sb({ metadata: { ownerAgentId: 'agent-live' } })).bucket, 'kept-by-reference');
assert.equal(decide(sb({ metadata: { rootAgentId: 'agent-live' } })).bucket, 'kept-by-reference');
assert.equal(decide(sb({ metadata: { codeSessionId: 'cs-gone' } })).eligible, true);
// render guard (even when old and unreferenced)
assert.equal(
  decide(sb({ metadata: { roseOrigin: 'render:srv-1', roseStack: 'render:srv-1|db:x' } })).bucket,
  'kept-render'
);
// purpose guard
assert.equal(decide(sb({ metadata: { purpose: 'lh-code-verify' } })).bucket, 'kept-purpose');
assert.equal(decide(sb({ metadata: { purpose: 'x', roseOrigin: 'host:boxes' } })).eligible, false);
// age floors
assert.equal(decide(sb({ startedAt: hoursAgo(23) })).bucket, 'kept-too-young');
assert.equal(decide(sb({ startedAt: hoursAgo(25) })).eligible, true);
assert.equal(
  decide(sb({ startedAt: hoursAgo(71), metadata: { roseOrigin: 'host:boxes' } })).bucket,
  'kept-too-young'
);
assert.equal(
  decide(sb({ startedAt: hoursAgo(73), metadata: { roseOrigin: 'host:boxes' } })).eligible,
  true
);
// other origins (e.g. blackbox:<run>) are never ours to reap here
assert.equal(
  decide(sb({ metadata: { roseOrigin: 'ci:run', roseStack: 'blackbox:1' } })).bucket,
  'kept-other-origin'
);
