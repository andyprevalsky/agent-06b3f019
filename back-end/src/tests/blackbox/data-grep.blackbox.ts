#!/usr/bin/env tsx
/**
 * Black-box tests for the DB-backed Grep contract.
 */

import { prisma } from '../../providers/database';
import {
  requestGrep,
  assertStatus,
  assertBody,
  requireContent,
  requireInvalidGrepParam,
  forbidLineNumbers,
  cleanup,
  seedFixture,
  WORD_BOUNDARY_MESSAGES,
} from './data-grep.helpers';
import {
  testSourceSpecificFilterValidation,
  testTransactionFiltersAndAggregates,
  testTransactionTenantIsolation,
  testTransactionSummary,
  testDocumentSummary,
  testDocumentReturnsEveryMatchingLine,
  testMultiSourceGrep,
  testSourceStatus,
  testSnapshotEndpoint,
} from './data-grep-sources.cases';
import { testGrepParameterContract } from './data-grep-contract.cases';

async function testSchemaAndRemovedParams(userId: string): Promise<void> {
  for (const param of [
    'path',
    'glob',
    'type',
    'output_mode',
    'person_id',
    'limit',
    'roles',
    'search_in',
    'tool_name',
    'tool_status',
  ]) {
    const res = await requestGrep(userId, { pattern: 'x', [param]: 'bad' });
    assertStatus(res.status, 400, res.data);
    if ((res.data as { error?: string }).error !== 'INVALID_GREP_PARAM') {
      throw new Error(`Expected INVALID_GREP_PARAM for ${param}, got ${JSON.stringify(res.data)}`);
    }
  }

  for (const source of ['agent_network_user_messages', 'agent_network_tool_results']) {
    const res = await requestGrep(userId, { pattern: 'x', source });
    assertStatus(res.status, 400, res.data);
    if ((res.data as { error?: string }).error !== 'SOURCE_NOT_FOUND') {
      throw new Error(`Expected SOURCE_NOT_FOUND for ${source}, got ${JSON.stringify(res.data)}`);
    }
  }
}

async function testAllSources(userId: string, agentId: string): Promise<void> {
  const res = await requestGrep(userId, {
    pattern: 'Aurora|Northstar|Atlas',
    agent_id: agentId,
    head_limit: 20,
  });
  assertStatus(res.status, 200, res.data);
  const body = assertBody(res.data);
  if (body.sources.join(',') !== 'messages,network,agent_network') {
    throw new Error(`Expected all sources, got ${body.sources.join(',')}`);
  }
  for (const source of ['messages', 'network', 'agent_network'] as const) {
    if (!body.matches.some((match) => match.source === source)) {
      throw new Error(`Expected omitted source search to include ${source}`);
    }
  }
}

async function testRegexAndSources(userId: string, agentId: string): Promise<void> {
  let res = await requestGrep(userId, { pattern: 'phase-[0-9]+ approved', source: 'messages' });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'phase-17 approved');

  res = await requestGrep(userId, { pattern: 'Signal Cartographer', source: 'network' });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'Principal Signal Cartographer');

  res = await requestGrep(userId, {
    pattern: 'Atlas handoff',
    source: 'agent_network',
    agent_id: agentId,
  });
  assertStatus(res.status, 200, res.data);
  const body = assertBody(res.data);
  for (const role of ['USER', 'ASSISTANT', 'TOOL'] as const) {
    if (!body.matches.some((match) => match.role === role && match.location.role === role)) {
      throw new Error(
        `Expected agent_network result with role ${role}, got ${JSON.stringify(body)}`
      );
    }
  }
  if (body.matches.some((match) => match.role === 'SYSTEM')) {
    throw new Error(`agent_network exposed a SYSTEM message: ${JSON.stringify(body)}`);
  }
  res = await requestGrep(userId, {
    pattern: 'Atlas handoff',
    source: 'agent_network',
    agent_id: agentId,
    role: 'SYSTEM',
  });
  assertStatus(res.status, 400, res.data);

  res = await requestGrep(userId, {
    pattern: 'Nimbus milestone|Calypso archive',
    source: 'documents',
    '-i': true,
  });
  assertStatus(res.status, 200, res.data);
  const documents = assertBody(res.data);
  if (
    documents.total_matches !== 2 ||
    !documents.matches.every((match) => match.source === 'documents') ||
    !documents.matches.some((match) => match.location.source_name === 'chatgpt') ||
    !documents.matches.some((match) => match.location.source_name === 'obsidian')
  ) {
    throw new Error(`Expected document grep matches, got ${JSON.stringify(documents)}`);
  }
}

async function testDocumentFilters(userId: string): Promise<void> {
  let res = await requestGrep(userId, {
    pattern: 'Meridian research preference',
    source: 'documents',
    filters: { document_source: 'claude' },
  });
  assertStatus(res.status, 200, res.data);
  const claudeOnly = assertBody(res.data);
  if (claudeOnly.total_matches !== 1 || claudeOnly.matches[0]?.location.source_name !== 'claude') {
    throw new Error(`Expected only Claude document match, got ${JSON.stringify(claudeOnly)}`);
  }

  res = await requestGrep(userId, {
    pattern: 'Calypso archive',
    source: 'documents',
    filters: { path: 'Projects/Calypso.md', tag: 'vendor' },
  });
  assertStatus(res.status, 200, res.data);
  const byPathAndTag = assertBody(res.data);
  if (
    byPathAndTag.total_matches !== 1 ||
    byPathAndTag.matches[0]?.path !== 'documents/obsidian/main/Projects/Calypso.md'
  ) {
    throw new Error(`Expected Obsidian path/tag match, got ${JSON.stringify(byPathAndTag)}`);
  }

  res = await requestGrep(userId, {
    pattern: 'provider sync reminders',
    source: 'documents',
    filters: { since: '2026-01-07', until: '2026-01-07T23:59:59.000Z' },
  });
  assertStatus(res.status, 200, res.data);
  const byDate = assertBody(res.data);
  if (byDate.total_matches !== 1 || byDate.matches[0]?.location.source_name !== 'apple_notes') {
    throw new Error(`Expected Apple Notes date-filtered match, got ${JSON.stringify(byDate)}`);
  }
}

async function testFlags(userId: string): Promise<void> {
  let res = await requestGrep(userId, {
    pattern: 'mixedcase beacon',
    source: 'messages',
    '-i': true,
  });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'MiXeDcAsE Beacon');

  res = await requestGrep(userId, {
    pattern: 'Multiline incident START.*incident END',
    source: 'messages',
    multiline: true,
  });
  assertStatus(res.status, 200, res.data);
  const multiline = assertBody(res.data);
  requireContent(multiline, 'Multiline incident START');
  requireContent(multiline, 'incident END');

  res = await requestGrep(userId, {
    pattern: 'Aurora budget',
    source: 'messages',
    '-A': 1,
  });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'After-context evidence');

  res = await requestGrep(userId, {
    pattern: 'Aurora budget',
    source: 'messages',
    '-B': 1,
  });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'Before-context evidence');

  res = await requestGrep(userId, {
    pattern: 'Aurora budget',
    source: 'messages',
    context: 1,
  });
  assertStatus(res.status, 200, res.data);
  const context = assertBody(res.data);
  requireContent(context, 'Before-context evidence');
  requireContent(context, 'After-context evidence');
  const contextRecords = context.matches[0]?.records;
  if (
    contextRecords?.map((record) => record.relation).join(',') !== 'before,match,after' ||
    contextRecords[0]?.message !== 'Before-context evidence: finance owner noted' ||
    contextRecords[1]?.message !== 'Aurora budget: phase-17 approved' ||
    contextRecords[2]?.message !== 'After-context evidence: forecast packet delivered'
  ) {
    throw new Error(
      `Expected aligned oldest-first message records, got ${JSON.stringify(context)}`
    );
  }

  res = await requestGrep(userId, {
    pattern: 'Aurora budget',
    source: 'messages',
    '-n': false,
  });
  assertStatus(res.status, 200, res.data);
  forbidLineNumbers(assertBody(res.data));

  res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    source: 'messages',
    head_limit: 5,
    offset: 20,
  });
  assertStatus(res.status, 200, res.data);
  const paged = assertBody(res.data);
  requireContent(paged, 'Ledger entry 21');
  if (paged.applied_limit !== 5 || paged.applied_offset !== 20) {
    throw new Error(`Expected pagination metadata, got ${JSON.stringify(paged)}`);
  }
  if (
    paged.returned !== 5 ||
    paged.has_more !== true ||
    paged.next_offset !== 25 ||
    paged.display_order !== 'oldest_first' ||
    paged.context_unit !== 'message_record'
  ) {
    throw new Error(
      `Expected explicit message pagination/order metadata, got ${JSON.stringify(paged)}`
    );
  }
}

async function testInvalidRegex(userId: string): Promise<void> {
  const res = await requestGrep(userId, { pattern: '[' });
  assertStatus(res.status, 400, res.data);
  if ((res.data as { error?: string }).error !== 'INVALID_PATTERN') {
    throw new Error(`Expected INVALID_PATTERN, got ${JSON.stringify(res.data)}`);
  }
}

// Catastrophic-backtracking patterns must be rejected (fast 400) before they
// reach Postgres `~`, which would otherwise run for seconds-to-minutes.
async function testRedosGuardRejects(userId: string): Promise<void> {
  for (const pattern of ['(a+)+$', '([a-z]+)*$', '(.*a){20}$', '(\\w+\\s?)+$', '(a|a)*$']) {
    const res = await requestGrep(userId, { pattern, source: 'messages' });
    assertStatus(res.status, 400, res.data);
    if ((res.data as { error?: string }).error !== 'INVALID_PATTERN') {
      throw new Error(
        `Expected INVALID_PATTERN for ReDoS pattern ${pattern}, got ${JSON.stringify(res.data)}`
      );
    }
  }
}

// Regex features that are valid in JS but not Postgres ARE must be normalized
// and succeed (200), not 500: named groups → plain groups, inline (?i) → -i.
async function testDialectNormalization(userId: string): Promise<void> {
  let res = await requestGrep(userId, { pattern: '(?<grp>phase)-17', source: 'messages' });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'phase-17 approved');

  res = await requestGrep(userId, { pattern: '(?i)aurora budget', source: 'messages' });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'Aurora budget');

  // JS word boundaries must keep JS meaning in Postgres, where `\b` is a
  // backspace: a valid-looking `\bpassport\b` used to match nothing at all.
  res = await requestGrep(userId, { pattern: '\\bphase-17\\b', source: 'messages' });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'phase-17 approved');

  res = await requestGrep(userId, { pattern: '\\bsolstice\\b', source: 'documents', '-i': true });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'Solstice notebook');

  res = await requestGrep(userId, { pattern: '\\Bolstice', source: 'documents' });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'Solstice notebook');

  res = await requestGrep(userId, { pattern: '\\bolstice', source: 'documents' });
  assertStatus(res.status, 200, res.data);
  if (assertBody(res.data).total_matches !== 0) {
    throw new Error(`\\bolstice must not match inside "Solstice": ${JSON.stringify(res.data)}`);
  }
}

async function testAsciiWordBoundaries(userId: string): Promise<void> {
  for (const pattern of ['\\bpassport\\b', '\\Bpassport', 'passport\\B']) {
    for (const caseInsensitive of [false, true]) {
      const expected = WORD_BOUNDARY_MESSAGES.filter((message) =>
        new RegExp(pattern, caseInsensitive ? 'i' : '').test(message)
      );
      const res = await requestGrep(userId, {
        pattern,
        source: 'messages',
        '-i': caseInsensitive,
      });
      assertStatus(res.status, 200, res.data);
      const body = assertBody(res.data);
      const actual = body.matches.flatMap((match) =>
        (match.records ?? [])
          .filter((record) => record.relation === 'match')
          .map((record) => record.message)
      );
      if (
        body.total_matches !== expected.length ||
        JSON.stringify(actual.sort()) !== JSON.stringify(expected.sort())
      ) {
        throw new Error(`ASCII JS boundary mismatch for ${pattern}, -i=${caseInsensitive}`);
      }
    }
  }
}

// Realistic, safe (degree ≤ 2) regexes the model actually emits must NOT be
// caught by the ReDoS guard — guards against false-positives nerfing the model.
async function testRealisticPatternsAllowed(userId: string): Promise<void> {
  for (const pattern of [
    '\\$[0-9,]+(\\.[0-9]{2})?',
    '(invoice|receipt|order)\\s+#?[0-9]+',
    'meeting.*tomorrow',
    '[\\w.]+@[\\w.]+',
    'v[0-9]+\\.[0-9]+\\.[0-9]+',
    '\\bphase-[0-9]+\\b',
    '[A-Z]{2,4}-[0-9]{2,5}',
  ]) {
    const res = await requestGrep(userId, { pattern, source: 'messages' });
    assertStatus(res.status, 200, res.data);
  }
}

// messages-only narrowing: `person` scopes to one contact, `since` to a time cutoff.
async function testPersonAndSinceFilters(userId: string): Promise<void> {
  // person resolves Lighthouse Archive (who has the seeded messages).
  let res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    source: 'messages',
    person: 'Lighthouse Archive',
  });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'Ledger entry');

  // unknown person → zero matches (not a silent unscoped search).
  res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    source: 'messages',
    person: 'Nobody Here',
  });
  assertStatus(res.status, 200, res.data);
  if (assertBody(res.data).total_matches !== 0) {
    throw new Error(`Expected 0 matches for unknown person, got ${JSON.stringify(res.data)}`);
  }

  // Top-level `person` must also merge on the multi-source `sources` path (a
  // message-family source selected via `sources`, not singular `source`).
  // Regression: an unknown person here must still scope to zero — if `person`
  // were dropped on the plural path the query would return unscoped matches.
  res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    sources: ['messages'],
    person: 'Nobody Here',
  });
  assertStatus(res.status, 200, res.data);
  if (assertBody(res.data).total_matches !== 0) {
    throw new Error(
      `Expected 0 matches for unknown person via sources[], got ${JSON.stringify(res.data)}`
    );
  }

  // since excludes the 2026-01-01 Aurora message but keeps the 2026-01-03 ledger.
  res = await requestGrep(userId, {
    pattern: 'Aurora budget|Ledger entry',
    source: 'messages',
    since: '2026-01-03T00:00:00Z',
  });
  assertStatus(res.status, 200, res.data);
  const body = assertBody(res.data);
  requireContent(body, 'Ledger entry');
  for (const match of body.matches) {
    if (match.content.includes('Aurora budget: phase-17 approved')) {
      throw new Error(
        `Expected 'since' to exclude the older Aurora message, got ${JSON.stringify(match)}`
      );
    }
  }
}

/**
 * Regression for prod agent e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc (2026-08-03).
 *
 * grep printed `network/Andy H. Ramcke.contact` and
 * `messages/<thread>.thread/<id>`; the explore agent fed them back as
 * `filters.path` and got HTTP 400 INVALID_GREP_PARAM, then tried web_fetch on the
 * same strings and burned four paid provider calls. grep advertises grep
 * semantics, so an address it prints must be an address it accepts.
 *
 * This drives real emitted values -- it greps first, then feeds the returned
 * `path` back verbatim. It does not hard-code a path, so it cannot pass by
 * agreeing with a fixture.
 */
async function testEmittedPathRoundTrips(userId: string): Promise<void> {
  // network: grep -> take the emitted path -> feed it back
  let res = await requestGrep(userId, { pattern: 'Lighthouse', source: 'network' });
  assertStatus(res.status, 200, res.data);
  const network = assertBody(res.data);
  if (network.matches.length === 0) {
    throw new Error('network seed produced no match to round-trip');
  }
  const networkPath = network.matches[0].path;

  res = await requestGrep(userId, {
    pattern: 'Lighthouse',
    source: 'network',
    filters: { path: networkPath },
  });
  assertStatus(res.status, 200, res.data);
  const networkScoped = assertBody(res.data);
  if (networkScoped.matches.length !== 1 || networkScoped.matches[0].path !== networkPath) {
    throw new Error(
      `network path ${networkPath} did not select its own record: ${JSON.stringify(networkScoped)}`
    );
  }

  // messages: the same round-trip, and a thread prefix addresses the whole thread
  res = await requestGrep(userId, { pattern: 'Ledger entry', source: 'messages' });
  assertStatus(res.status, 200, res.data);
  const messages = assertBody(res.data);
  if (messages.matches.length === 0) {
    throw new Error('messages seed produced no match to round-trip');
  }
  const messagePath = messages.matches[0].path;

  res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    source: 'messages',
    filters: { path: messagePath },
  });
  assertStatus(res.status, 200, res.data);
  const messageScoped = assertBody(res.data);
  if (messageScoped.matches.length !== 1 || messageScoped.matches[0].path !== messagePath) {
    throw new Error(
      `message path ${messagePath} did not select its own record: ${JSON.stringify(messageScoped)}`
    );
  }

  const threadPrefix = messagePath.slice(0, messagePath.lastIndexOf('/'));
  res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    source: 'messages',
    filters: { path: threadPrefix },
  });
  assertStatus(res.status, 200, res.data);
  const threadScoped = assertBody(res.data);
  if (threadScoped.matches.length < 1) {
    throw new Error(`thread prefix ${threadPrefix} selected nothing`);
  }
  for (const match of threadScoped.matches) {
    if (!match.path.startsWith(`${threadPrefix}/`)) {
      throw new Error(`thread prefix leaked a foreign match: ${match.path}`);
    }
  }

  // transactions, documents, agent_network: same invariant, every emitting source.
  for (const [source, pattern] of [
    ['transactions', 'Starbucks'],
    ['documents', 'Calypso'],
  ] as const) {
    res = await requestGrep(userId, { pattern, source });
    assertStatus(res.status, 200, res.data);
    const seed = assertBody(res.data);
    if (seed.matches.length === 0) {
      throw new Error(`${source} seed produced no match to round-trip`);
    }
    const emitted = seed.matches[0].path;

    res = await requestGrep(userId, { pattern, source, filters: { path: emitted } });
    assertStatus(res.status, 200, res.data);
    const scoped = assertBody(res.data);
    if (scoped.matches.length !== 1 || scoped.matches[0].path !== emitted) {
      throw new Error(
        `${source} path ${emitted} did not select its own record: ${JSON.stringify(scoped)}`
      );
    }
  }

  // The printed account label must also round-trip: results show `<name> ****<mask>`,
  // which previously matched neither a.name nor a.mask and returned nothing.
  res = await requestGrep(userId, { pattern: 'Starbucks', source: 'transactions' });
  assertStatus(res.status, 200, res.data);
  const txn = assertBody(res.data);
  const accountLine = /account: (.+)/.exec(txn.matches[0]?.content ?? '');
  if (accountLine) {
    res = await requestGrep(userId, {
      pattern: 'Starbucks',
      source: 'transactions',
      filters: { account: accountLine[1].trim() },
    });
    assertStatus(res.status, 200, res.data);
    const byAccount = assertBody(res.data);
    if (byAccount.matches.length === 0) {
      throw new Error(`printed account label "${accountLine[1].trim()}" selected nothing`);
    }
  }

  // A path printed for another source is a caller error, not an empty result.
  res = await requestGrep(userId, {
    pattern: 'anything',
    source: 'network',
    filters: { path: messagePath },
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'cross-source path');

  // And the string the agent invented is still rejected.
  res = await requestGrep(userId, {
    pattern: 'anything',
    source: 'network',
    filters: { path: 'https://internal/messages/+19729777432.thread' },
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'non-grep path');
}

async function runAll(): Promise<void> {
  const { userId, agentId } = await seedFixture();
  const tests = [
    ['schema rejects removed params/sources', () => testSchemaAndRemovedParams(userId)],
    ['omitted source searches all buckets', () => testAllSources(userId, agentId)],
    ['regex and explicit sources work', () => testRegexAndSources(userId, agentId)],
    ['grep flags work', () => testFlags(userId)],
    ['invalid regex returns 400', () => testInvalidRegex(userId)],
    ['ReDoS-catastrophic patterns rejected with 400', () => testRedosGuardRejects(userId)],
    ['dialect patterns normalized and succeed', () => testDialectNormalization(userId)],
    [
      'word boundaries preserve ASCII JS semantics beside Unicode',
      () => testAsciiWordBoundaries(userId),
    ],
    ['realistic safe patterns are allowed', () => testRealisticPatternsAllowed(userId)],
    ['person and since narrow messages', () => testPersonAndSinceFilters(userId)],
    ['source-specific filters are validated', () => testSourceSpecificFilterValidation(userId)],
    ['emitted path round-trips as filters.path', () => testEmittedPathRoundTrips(userId)],
    ['documents filters work', () => testDocumentFilters(userId)],
    ['documents return every matching line', () => testDocumentReturnsEveryMatchingLine(userId)],
    ['transactions filters and aggregates work', () => testTransactionFiltersAndAggregates(userId)],
    ['transaction grep is tenant isolated', () => testTransactionTenantIsolation(userId)],
    ['summary includes transactions', () => testTransactionSummary(userId)],
    ['summary includes documents', () => testDocumentSummary(userId)],
    ['multi-source grep with channel routing', () => testMultiSourceGrep(userId)],
    [
      'every prod-observed parameter shape is accepted or named with guidance',
      () => testGrepParameterContract(userId, agentId),
    ],
    ['per-source connectivity status', () => testSourceStatus(userId)],
    [
      'snapshot endpoint returns distilled snapshot + revisions',
      () => testSnapshotEndpoint(userId),
    ],
  ] as const;

  try {
    for (const [name, fn] of tests) {
      await fn();
      console.log(`PASS ${name}`);
    }
  } finally {
    await cleanup(userId);
    await prisma.$disconnect();
  }
}

runAll().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
