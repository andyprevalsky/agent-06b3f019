/**
 * data-grep cases: source-specific filters, transactions, summaries, source status and snapshot.
 * Registered by data-grep.blackbox.ts.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prisma } from '../../providers/database';
import {
  BASE_URL,
  SummaryResponse,
  apiHeaders,
  requestGrep,
  requestSummary,
  requestSourceStatus,
  assertStatus,
  assertBody,
  requireContent,
  requireInvalidGrepParam,
  cleanup,
  seedPlaidFixture,
} from './data-grep.helpers';

export async function testSourceSpecificFilterValidation(userId: string): Promise<void> {
  let res = await requestGrep(userId, {
    pattern: 'Starbucks',
    source: 'transactions',
    filters: { person: 'Lighthouse Archive' },
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'unsupported transaction filter');

  res = await requestGrep(userId, {
    pattern: 'Ledger entry',
    source: 'messages',
    filters: { person: 'Lighthouse Archive', min_amount: 1 },
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'unsupported message filter');

  // Filters against a purely-local `sources` selection (no filterable family)
  // must be rejected, not silently dropped — the multi-source path had bypassed
  // rejectUnsupportedFilters entirely.
  res = await requestGrep(userId, {
    pattern: 'anything',
    sources: ['network'],
    filters: { min_amount: 1 },
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'unsupported local-source filter');

  res = await requestGrep(userId, {
    pattern: 'Starbucks',
    source: 'transactions',
    filters: ['status'],
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'non-object filters');

  for (const [label, filters] of [
    ['invalid transaction min_amount', { min_amount: '1' }],
    ['invalid transaction status', { status: 'settled' }],
    ['invalid transaction since', { since: 'not-a-date' }],
    ['invalid transaction include_pending_in_totals', { include_pending_in_totals: 'true' }],
    ['invalid message person', { person: ['Lighthouse Archive'] }],
    ['invalid message since', { since: 'not-a-date' }],
  ] as const) {
    res = await requestGrep(userId, {
      pattern: label.includes('message') ? 'Ledger entry' : 'Starbucks',
      source: label.includes('message') ? 'messages' : 'transactions',
      filters,
    });
    assertStatus(res.status, 400, res.data);
    requireInvalidGrepParam(res.data, label);
  }

  res = await requestGrep(userId, {
    pattern: 'Nimbus',
    source: 'documents',
    filters: { tag: 123 },
  });
  assertStatus(res.status, 400, res.data);
  requireInvalidGrepParam(res.data, 'invalid document tag');
}

export async function testTransactionFiltersAndAggregates(userId: string): Promise<void> {
  let res = await requestGrep(userId, {
    pattern: 'starbucks|coffee',
    source: 'transactions',
    '-i': true,
    filters: {
      since: '2025-01-01',
      until: '2025-12-31',
      account: 'checking',
      min_amount: 0,
      max_amount: 10,
      status: 'all',
      include_pending_in_totals: false,
    },
    head_limit: 1,
  });
  assertStatus(res.status, 200, res.data);
  const defaultTotals = assertBody(res.data);
  if (defaultTotals.total_matches !== 2 || defaultTotals.matches.length !== 1) {
    throw new Error(
      `Expected full transaction total with one returned row, got ${JSON.stringify(defaultTotals)}`
    );
  }
  const currency = defaultTotals.summaries?.transactions?.currencies.find(
    (row) => row.currency === 'USD'
  );
  if (
    defaultTotals.summaries?.transactions?.totals_include_pending !== false ||
    currency?.count !== 1 ||
    currency.outflow !== '5.25'
  ) {
    throw new Error(
      `Expected posted-only aggregate over full filtered set, got ${JSON.stringify(defaultTotals)}`
    );
  }
  requireContent(defaultTotals, 'Starbucks');

  res = await requestGrep(userId, {
    pattern: 'starbucks|coffee',
    source: 'transactions',
    '-i': true,
    filters: {
      since: '2025-01-01',
      until: '2025-12-31',
      account: 'checking',
      min_amount: 0,
      max_amount: 10,
      status: 'all',
      include_pending_in_totals: true,
    },
    head_limit: 1,
  });
  assertStatus(res.status, 200, res.data);
  const withPendingTotals = assertBody(res.data);
  const withPendingCurrency = withPendingTotals.summaries?.transactions?.currencies.find(
    (row) => row.currency === 'USD'
  );
  if (
    withPendingTotals.summaries?.transactions?.totals_include_pending !== true ||
    withPendingCurrency?.count !== 2 ||
    withPendingCurrency.outflow !== '12.25'
  ) {
    throw new Error(
      `Expected pending-inclusive aggregate, got ${JSON.stringify(withPendingTotals)}`
    );
  }

  res = await requestGrep(userId, {
    pattern: 'starbucks|coffee',
    source: 'transactions',
    '-i': true,
    filters: { status: 'posted' },
  });
  assertStatus(res.status, 200, res.data);
  const postedOnly = assertBody(res.data);
  if (postedOnly.matches.some((match) => match.content.includes('status: pending'))) {
    throw new Error(
      `Expected posted filter to hide pending rows, got ${JSON.stringify(postedOnly)}`
    );
  }
  const postedStarbucks = postedOnly.matches.find((match) => match.content.includes('Starbucks'));
  if (
    postedStarbucks === undefined ||
    !postedStarbucks.content.includes('date: 2025-01-10') ||
    !postedStarbucks.content.includes('amount: 5.25 USD')
  ) {
    throw new Error(
      `Expected default transaction row snippet to include core date/amount fields, got ${JSON.stringify(postedOnly)}`
    );
  }
}

export async function testTransactionTenantIsolation(userId: string): Promise<void> {
  const otherUserId = `grep-other-${randomUUID()}`;
  await cleanup(otherUserId);
  await prisma.user.create({ data: { userId: otherUserId, isAnonymous: true } });
  await seedPlaidFixture(otherUserId);
  try {
    const res = await requestGrep(userId, {
      pattern: 'Payroll|Coffee Supplies',
      source: 'transactions',
      '-i': true,
    });
    assertStatus(res.status, 200, res.data);
    const body = assertBody(res.data);
    if (body.total_matches !== 2) {
      throw new Error(
        `Expected only current user's transaction matches, got ${JSON.stringify(body)}`
      );
    }
  } finally {
    await cleanup(otherUserId);
  }
}

export async function testTransactionSummary(userId: string): Promise<void> {
  const res = await requestSummary(userId);
  assertStatus(res.status, 200, res.data);
  const body = SummaryResponse.parse(res.data);
  const transactions = body.sources.transactions;
  if (
    transactions === undefined ||
    transactions.total_transactions !== 4 ||
    transactions.account_count !== 2 ||
    !transactions.institutions.includes('First Platypus Bank') ||
    transactions.date_range.from?.slice(0, 10) !== '2025-01-10' ||
    transactions.date_range.to?.slice(0, 10) !== '2025-01-20'
  ) {
    throw new Error(`Expected transaction summary, got ${JSON.stringify(body)}`);
  }
}

export async function testDocumentSummary(userId: string): Promise<void> {
  const res = await requestSummary(userId);
  assertStatus(res.status, 200, res.data);
  const body = SummaryResponse.parse(res.data);
  const documents = body.sources.documents;
  if (
    documents === undefined ||
    documents.total_documents !== 4 ||
    documents.sources.chatgpt !== 1 ||
    documents.sources.claude !== 1 ||
    documents.sources.apple_notes !== 1 ||
    documents.sources.obsidian !== 1 ||
    documents.date_range.from?.slice(0, 10) !== '2026-01-06' ||
    documents.date_range.to?.slice(0, 10) !== '2026-01-08'
  ) {
    throw new Error(`Expected document summary, got ${JSON.stringify(body)}`);
  }
}

export const SourceStatusResponse = z.object({
  statuses: z.array(
    z.object({
      source: z.string(),
      connector: z.string().nullable(),
      connected: z.boolean(),
      connectUrl: z.string().nullable(),
    })
  ),
});

// Multi-source grep: `sources:['email','imessage']` searches MessageRecord and
// returns 200. The seeded fixture only has EMAIL-channel rows, so email matches
// (channel-filtered) while imessage returns nothing — proving channel routing.
export async function testMultiSourceGrep(userId: string): Promise<void> {
  let res = await requestGrep(userId, {
    pattern: 'Aurora budget',
    sources: ['email', 'imessage'],
  });
  assertStatus(res.status, 200, res.data);
  const body = assertBody(res.data);
  if (body.sources.join(',') !== 'email,imessage') {
    throw new Error(`Expected echoed sources email,imessage, got ${body.sources.join(',')}`);
  }
  requireContent(body, 'Aurora budget');

  // imessage alone must find nothing (no IMESSAGE-channel rows in the fixture),
  // confirming the channel WHERE clause actually restricts the search.
  res = await requestGrep(userId, { pattern: 'Aurora budget', source: 'imessage' });
  assertStatus(res.status, 200, res.data);
  if (assertBody(res.data).total_matches !== 0) {
    throw new Error(
      `Expected imessage-only grep to find 0 EMAIL rows, got ${JSON.stringify(res.data)}`
    );
  }

  // email alone must find the same EMAIL row that `messages` finds.
  res = await requestGrep(userId, { pattern: 'Aurora budget', source: 'email' });
  assertStatus(res.status, 200, res.data);
  requireContent(assertBody(res.data), 'Aurora budget');

  // unknown source in the array → 400 SOURCE_NOT_FOUND (not a 500).
  res = await requestGrep(userId, { pattern: 'x', sources: ['email', 'not_a_source'] });
  assertStatus(res.status, 400, res.data);
  if ((res.data as { error?: string }).error !== 'SOURCE_NOT_FOUND') {
    throw new Error(
      `Expected SOURCE_NOT_FOUND for bad sources entry, got ${JSON.stringify(res.data)}`
    );
  }
}

// Per-source connectivity: local source (network) is always connected with no
// connectUrl; a connector-backed source with no Integration row (email→gmail)
// is disconnected with a mintable connectUrl.
export async function testSourceStatus(userId: string): Promise<void> {
  const res = await requestSourceStatus(userId, 'email,network');
  assertStatus(res.status, 200, res.data);
  const body = SourceStatusResponse.parse(res.data);

  const email = body.statuses.find((s) => s.source === 'email');
  if (
    email === undefined ||
    email.connector !== 'gmail' ||
    email.connected !== false ||
    email.connectUrl === null ||
    !email.connectUrl.startsWith('http')
  ) {
    throw new Error(`Expected disconnected email with connectUrl, got ${JSON.stringify(body)}`);
  }

  const network = body.statuses.find((s) => s.source === 'network');
  if (
    network === undefined ||
    network.connector !== null ||
    network.connected !== true ||
    network.connectUrl !== null
  ) {
    throw new Error(
      `Expected local network connected with no connectUrl, got ${JSON.stringify(body)}`
    );
  }

  // A non-gmail connector-backed source returns the stub connect URL.
  const whatsappRes = await requestSourceStatus(userId, 'whatsapp');
  assertStatus(whatsappRes.status, 200, whatsappRes.data);
  const whatsappBody = SourceStatusResponse.parse(whatsappRes.data);
  const whatsapp = whatsappBody.statuses[0];
  if (
    whatsapp?.connectUrl !== 'https://roselabs.ai/connect/whatsapp' ||
    whatsapp.connected !== false
  ) {
    throw new Error(`Expected whatsapp stub connect URL, got ${JSON.stringify(whatsappBody)}`);
  }

  // sms is not a grep source (Mac SMS is ingested via imessage / IMESSAGE).
  const smsRes = await requestSourceStatus(userId, 'sms');
  assertStatus(smsRes.status, 400, smsRes.data);

  // Documents is an umbrella grep source; concrete document providers are
  // separate connector keys for source-connect gates.
  const notesRes = await requestSourceStatus(userId, 'apple_notes');
  assertStatus(notesRes.status, 200, notesRes.data);
  const notesBody = SourceStatusResponse.parse(notesRes.data);
  const notes = notesBody.statuses[0];
  if (
    notes?.source !== 'apple_notes' ||
    notes.connector !== 'apple_notes' ||
    notes.connected !== false ||
    notes.connectUrl !== 'https://roselabs.ai/connect/apple_notes'
  ) {
    throw new Error(
      `Expected apple_notes provider source status, got ${JSON.stringify(notesBody)}`
    );
  }

  // Unknown source key → 400, not 500.
  const badRes = await requestSourceStatus(userId, 'not_a_source');
  assertStatus(badRes.status, 400, badRes.data);
  if ((badRes.data as { error?: string }).error !== 'SOURCE_NOT_FOUND') {
    throw new Error(`Expected SOURCE_NOT_FOUND, got ${JSON.stringify(badRes.data)}`);
  }
}

export async function requestSnapshot(userId: string) {
  const response = await fetch(`${BASE_URL}/api/data/snapshot`, {
    headers: apiHeaders(userId),
  });
  const data = await response.json();
  return { status: response.status, data };
}

// GET /api/data/snapshot returns the distilled user snapshot plus its recent
// revision ledger (repo.getUserSnapshot). Seed a snapshot + one revision, then
// read it back through the authenticated route.
export async function testSnapshotEndpoint(userId: string): Promise<void> {
  const snapshot = await prisma.userSnapshot.create({
    data: {
      userId,
      content: { headline: 'Lighthouse archive lead', focus: ['signal', 'cartography'] },
      version: 3,
    },
  });
  await prisma.userSnapshotRevision.create({
    data: {
      userId,
      snapshotId: snapshot.id,
      source: 'grep-blackbox',
      changes: { added: ['focus'] },
      model: 'rose-1-flash',
      promptKey: 'snapshot.distill',
    },
  });

  const res = await requestSnapshot(userId);
  assertStatus(res.status, 200, res.data);
  const body = res.data as {
    snapshot: {
      content?: { headline?: string };
      version?: number;
      revisions?: Array<{ source?: string; model?: string }>;
    } | null;
  };
  if (body.snapshot === null) {
    throw new Error(`Expected a snapshot, got null: ${JSON.stringify(res.data)}`);
  }
  if (
    body.snapshot.version !== 3 ||
    body.snapshot.content?.headline !== 'Lighthouse archive lead'
  ) {
    throw new Error(`Unexpected snapshot content/version: ${JSON.stringify(body.snapshot)}`);
  }
  if (
    !body.snapshot.revisions?.some(
      (r) => r.source === 'grep-blackbox' && r.model === 'rose-1-flash'
    )
  ) {
    throw new Error(`Expected the seeded revision in the ledger: ${JSON.stringify(body.snapshot)}`);
  }
}

/**
 * Text records follow ripgrep's content mode: every matching line comes back,
 * not only the window around the first match. 2026-10-12 eTA benchmark: the
 * SMS supervisor read a note with pattern "." and got only the synthetic
 * "source: documents" header line, concluded the note held no numbers, and
 * asked the user for facts the note contained.
 */
export async function testDocumentReturnsEveryMatchingLine(userId: string): Promise<void> {
  const externalId = `apple-notes-${randomUUID()}`;
  await prisma.userDataDocument.create({
    data: {
      userId,
      source: 'apple_notes',
      externalId,
      title: 'Pantry plan',
      content: 'Pantry plan\n\nFlour 2kg\nSugar 1kg\n\nDinner\nPasta night 2026-11-14',
      contentHash: `hash-${randomUUID()}`,
      sourceUpdatedAt: new Date('2026-01-09T09:00:00Z'),
      metadata: {},
    },
  });
  const longId = `apple-notes-${randomUUID()}`;
  await prisma.userDataDocument.create({
    data: {
      userId,
      source: 'apple_notes',
      externalId: longId,
      title: 'Long ledger',
      content: Array.from({ length: 400 }, (_, i) => `ledger row ${i + 1}`).join('\n'),
      contentHash: `hash-${randomUUID()}`,
      sourceUpdatedAt: new Date('2026-01-09T09:00:00Z'),
      metadata: {},
    },
  });
  try {
    const whole = await requestGrep(userId, {
      pattern: '.',
      source: 'documents',
      filters: { path: `documents/apple_notes/Pantry plan/${externalId}` },
    });
    assertStatus(whole.status, 200, whole.data);
    const wholeBody = assertBody(whole.data);
    requireContent(wholeBody, 'Flour 2kg');
    requireContent(wholeBody, 'Pasta night 2026-11-14');

    const two = await requestGrep(userId, {
      pattern: 'Flour|Pasta',
      source: 'documents',
      filters: { path: `documents/apple_notes/Pantry plan/${externalId}` },
    });
    assertStatus(two.status, 200, two.data);
    const content = assertBody(two.data).matches[0]?.content ?? '';
    if (!/Flour 2kg[\s\S]*\n--\n[\s\S]*Pasta night/.test(content) || content.includes('Sugar')) {
      throw new Error(`Expected both matching lines split by --, got ${JSON.stringify(content)}`);
    }

    const long = await requestGrep(userId, {
      pattern: 'ledger row',
      source: 'documents',
      filters: { path: `documents/apple_notes/Long ledger/${longId}` },
    });
    assertStatus(long.status, 200, long.data);
    const ledger = assertBody(long.data).matches[0]?.content ?? '';
    if (!ledger.includes('ledger row 250') || ledger.includes('ledger row 251')) {
      throw new Error(`Expected the per-record line cap at 250, got ${ledger.slice(-200)}`);
    }
    if (!ledger.includes('more matching lines')) {
      throw new Error('A capped record must say that matching lines were omitted');
    }
  } finally {
    await prisma.userDataDocument.deleteMany({
      where: { userId, externalId: { in: [externalId, longId] } },
    });
  }
}
