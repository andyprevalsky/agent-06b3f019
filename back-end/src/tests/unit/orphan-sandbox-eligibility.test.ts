#!/usr/bin/env tsx
// Pure rules of the one-time orphan reaper: every guard has its own fixture, so
// removing any guard flips a case below.
import assert from 'node:assert/strict';
import {
  assessProdReferences,
  databaseHostOf,
  decideOrphan,
  enforceProdReferenceGuard,
  MIN_PLAUSIBLE_PROD_REFS,
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

// production reference sanity guard: an empty/tiny read or a local database would
// make every untagged paused sandbox look orphaned
const ids = (prefix: string, n: number) =>
  new Set(Array.from({ length: n }, (_, i) => `${prefix}-${i}`));
const plausible: ProdReferences = {
  sandboxIds: ids('sb', 40),
  codeSessionIds: ids('cs', 40),
  agentIds: ids('ag', 40),
};
const PROD_URL = 'postgresql://postgres.ref:s3cr3t%40pw@db.abcdefgh.supabase.co:5432/postgres';
const okAssessment = assessProdReferences(plausible, PROD_URL);
assert.deepEqual(okAssessment, { host: 'db.abcdefgh.supabase.co', ok: true, problems: [] });
assert.equal(enforceProdReferenceGuard(okAssessment, true), null);
assert.equal(enforceProdReferenceGuard(okAssessment, false), null);
// the host is printed, credentials never are (even an unencoded '@' in the password)
assert.equal(
  databaseHostOf('postgresql://u:p@ss@Pooler.Example.com:6543/db?x=1'),
  'pooler.example.com'
);
assert.equal(databaseHostOf('postgresql://u:pw@[::1]:5432/db'), '::1');
assert.equal(databaseHostOf(undefined), null);
assert.equal(databaseHostOf('not a url'), null);
assert.ok(!JSON.stringify(okAssessment).includes('s3cr3t'));
// empty sets (each one alone) and tiny sets are refused
for (const name of ['sandboxIds', 'codeSessionIds', 'agentIds'] as const) {
  const empty = assessProdReferences({ ...plausible, [name]: new Set<string>() }, PROD_URL);
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.problems, [`${name} is empty`]);
  const tiny = assessProdReferences(
    { ...plausible, [name]: ids('x', MIN_PLAUSIBLE_PROD_REFS - 1) },
    PROD_URL
  );
  assert.equal(tiny.ok, false);
  assert.match(tiny.problems.join(), new RegExp(`${name} has ${MIN_PLAUSIBLE_PROD_REFS - 1} rows`));
}
assert.equal(
  assessProdReferences({ ...plausible, agentIds: ids('x', MIN_PLAUSIBLE_PROD_REFS) }, PROD_URL).ok,
  true
);
// an explicit lower floor is honoured, but empty is never acceptable and NaN cannot bypass it
const small = { ...plausible, agentIds: ids('x', 3) };
assert.equal(assessProdReferences(small, PROD_URL, 3).ok, true);
assert.equal(assessProdReferences(small, PROD_URL, 0).ok, true);
assert.equal(assessProdReferences(small, PROD_URL, Number.NaN).ok, false);
assert.equal(assessProdReferences({ ...plausible, agentIds: new Set() }, PROD_URL, 0).ok, false);
// local / devbox / compose databases are not production
for (const url of [
  'postgresql://postgres:postgres@localhost:5432/victoria',
  'postgresql://postgres:postgres@127.0.0.1:5432/victoria',
  'postgresql://postgres:postgres@[::1]:5432/victoria',
  'postgresql://postgres:postgres@10.1.2.3:5432/victoria',
  'postgresql://postgres:postgres@172.20.0.5:5432/victoria',
  'postgresql://postgres:postgres@192.168.1.9:5432/victoria',
  'postgresql://postgres:postgres@host.docker.internal:5432/victoria',
  'postgresql://postgres:postgres@postgres:5432/victoria',
  'postgresql://postgres:postgres@devbox.local:5432/victoria',
]) {
  const local = assessProdReferences(plausible, url);
  assert.equal(local.ok, false, url);
  assert.match(local.problems[0] ?? '', /local\/non-production database/, url);
  assert.ok(!local.problems.join().includes('postgres:postgres'), url);
}
assert.equal(assessProdReferences(plausible, 'postgresql://u:p@172.32.0.1:5432/db').ok, true);
assert.equal(assessProdReferences(plausible, undefined).ok, false);
// execute refuses; a dry run returns a loud warning instead of throwing
const bad = assessProdReferences(
  { sandboxIds: new Set(), codeSessionIds: new Set(), agentIds: new Set() },
  'postgresql://postgres:postgres@localhost:5432/victoria'
);
assert.throws(
  () => enforceProdReferenceGuard(bad, true),
  /refusing --execute.*sandboxIds is empty/
);
const warning = enforceProdReferenceGuard(bad, false);
assert.match(
  warning ?? '',
  /^WARNING: production references look wrong .*localhost.*--execute will refuse/
);
