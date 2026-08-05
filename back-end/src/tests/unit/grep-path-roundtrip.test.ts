#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Invariant: anything grep emits as `path`, grep can parse back.
 *
 * Regression for prod agent e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc (2026-08-03).
 * grep returned `network/Andy H. Ramcke.contact` and
 * `messages/+19729777432.thread/<id>`; the explore agent fed them back as
 * `filters.path` and got HTTP 400 `INVALID_GREP_PARAM`, then tried web_fetch on
 * the same strings and burned four paid provider calls. Five sources emitted a
 * path, one accepted a `path` filter, and zero round-tripped.
 *
 * This is a property test, not a case list: every source that can BUILD a path
 * must PARSE it back to the same components. A new source added to one half and
 * not the other fails here.
 */

import assert from 'node:assert/strict';
import {
  buildAccountLabel,
  buildAgentNetworkPath,
  buildDocumentPath,
  buildMessagePath,
  buildNetworkPath,
  buildTransactionPath,
  parseAccountLabel,
  parseGrepPath,
} from '../../domains/data/path';
import {
  buildAgentNetworkMatch,
  buildDocumentMatch,
  buildMessageMatch,
  buildNetworkMatch,
  buildTransactionMatch,
} from '../../domains/data/format';

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}`);
    throw error;
  }
}

/** The exact strings the prod agent was handed, plus the awkward shapes. */
const MESSAGE_THREADS = ['+19729777432', 'Andy Prevalsky', 'andy@example.com', 'no-name-person-id'];
const CONTACT_NAMES = ['Andy H. Ramcke', '+19729777432', 'andy@example.com'];

test('messages paths round-trip, with and without a message id', () => {
  for (const thread of MESSAGE_THREADS) {
    const withId = buildMessagePath(thread, 'msg-123');
    assert.deepEqual(parseGrepPath(withId), {
      source: 'messages',
      thread,
      messageId: 'msg-123',
    });

    // A thread prefix addresses the whole thread.
    const threadOnly = buildMessagePath(thread);
    assert.deepEqual(parseGrepPath(threadOnly), { source: 'messages', thread });
  }
});

test('the exact prod path parses back to its thread', () => {
  const emitted = 'messages/+19729777432.thread/90a11edd-a427-4df9-91a8-65eba7f7fd39';
  assert.deepEqual(parseGrepPath(emitted), {
    source: 'messages',
    thread: '+19729777432',
    messageId: '90a11edd-a427-4df9-91a8-65eba7f7fd39',
  });
});

test('network paths round-trip, including the exact prod contact', () => {
  for (const contact of CONTACT_NAMES) {
    assert.deepEqual(parseGrepPath(buildNetworkPath(contact)), { source: 'network', contact });
  }
  assert.deepEqual(parseGrepPath('network/Andy H. Ramcke.contact'), {
    source: 'network',
    contact: 'Andy H. Ramcke',
  });
});

test('agent_network paths round-trip', () => {
  const built = buildAgentNetworkPath(2, 'agent-abc', 'ASSISTANT', 'm-1');
  assert.deepEqual(parseGrepPath(built), {
    source: 'agent_network',
    depth: 2,
    agentId: 'agent-abc',
    role: 'ASSISTANT',
    messageId: 'm-1',
  });
});

test('transaction paths round-trip, and the account label survives its mask', () => {
  const built = buildTransactionPath('Chase', 'Checking', '1234', 'txn-9');
  assert.deepEqual(parseGrepPath(built), {
    source: 'transactions',
    institution: 'Chase',
    account: 'Checking ****1234',
    transactionId: 'txn-9',
  });

  // The printed label must decompose into exactly the columns it was built from.
  const label = buildAccountLabel('Checking', '1234');
  assert.equal(label, 'Checking ****1234');
  assert.deepEqual(parseAccountLabel(label), { accountName: 'Checking', accountMask: '1234' });
  assert.deepEqual(parseAccountLabel(buildAccountLabel('Checking', null)), {
    accountName: 'Checking',
  });

  // A missing institution still round-trips.
  assert.deepEqual(parseGrepPath(buildTransactionPath(null, 'Savings', null, 't-1')), {
    source: 'transactions',
    institution: 'unknown-institution',
    account: 'Savings',
    transactionId: 't-1',
  });
});

test('document paths round-trip', () => {
  assert.deepEqual(parseGrepPath(buildDocumentPath('obsidian', 'main', 'Projects/Calypso.md')), {
    source: 'documents',
    documentSource: 'obsidian',
    rest: 'main/Projects/Calypso.md',
  });
});

test('non-grep strings are rejected, not silently matched', () => {
  for (const bad of [
    '',
    '   ',
    'https://internal/messages/+19729777432.thread', // what the agent sent to web_fetch
    'some-other-service/thing',
    'messages/missing-suffix/abc',
    'network/missing-suffix',
    'agent_network/depth-not-a-number/a/b/c',
  ]) {
    assert.equal(parseGrepPath(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ── The half that actually matters: real emitters must produce parseable paths ──
//
// The build/parse checks above only prove path.ts agrees with itself. These drive
// the REAL formatters in format.ts, so if an emitter ever stops using the shared
// grammar, this fails — which is exactly how the original defect got in.

const INPUT = {
  regex: /Andy/,
  contextBefore: 0,
  contextAfter: 0,
  showLineNumbers: false,
} as never;

test('every real formatter emits a path that parses back', () => {
  const emitted: Array<{ label: string; path: string; expect: Record<string, unknown> }> = [
    {
      label: 'messages',
      path: buildMessageMatch(
        {
          id: '90a11edd',
          personId: 'p-1',
          firstName: null,
          lastName: null,
          phoneNumber: '+19729777432',
          email: null,
          channel: 'imessage',
          from: '+19729777432',
          to: 'me',
          message: 'Andy',
          timestamp: new Date('2026-05-11T22:53:13.642Z'),
        } as never,
        INPUT
      ).path,
      expect: { source: 'messages', thread: '+19729777432', messageId: '90a11edd' },
    },
    {
      label: 'network',
      path: buildNetworkMatch(
        {
          id: '7dbe7c16',
          firstName: 'Andy H.',
          lastName: 'Ramcke',
          email: null,
          phoneNumber: null,
          company: null,
          title: null,
          relation: null,
          communicationFrequency: null,
          messagesExchanged: null,
          createdAt: new Date('2026-05-11T22:53:13.642Z'),
        } as never,
        INPUT
      ).path,
      expect: { source: 'network', contact: 'Andy H. Ramcke' },
    },
    {
      label: 'agent_network',
      path: buildAgentNetworkMatch(
        {
          id: 'm-1',
          text: 'Andy',
          agentId: 'agent-abc',
          agentGoal: 'find andy',
          agentDepth: 2,
          role: 'ASSISTANT',
          metadata: null,
          filePointer: null,
          createdAt: new Date('2026-05-11T22:53:13.642Z'),
        } as never,
        INPUT
      ).path,
      expect: {
        source: 'agent_network',
        depth: 2,
        agentId: 'agent-abc',
        role: 'ASSISTANT',
        messageId: 'm-1',
      },
    },
    {
      label: 'transactions',
      path: buildTransactionMatch(
        {
          plaidTransactionId: 'txn-9',
          institutionName: 'Chase',
          accountName: 'Checking',
          accountMask: '1234',
          date: new Date('2026-05-11T00:00:00.000Z'),
          pending: false,
          direction: 'OUTFLOW',
          amount: '12.34',
          absoluteAmount: '12.34',
          isoCurrencyCode: 'USD',
          unofficialCurrencyCode: null,
          merchantName: 'Andy Coffee',
          name: 'Andy Coffee',
          originalDescription: null,
          category: [],
          personalFinanceCategory: null,
          personalFinanceDetailed: null,
        } as never,
        INPUT
      ).path,
      expect: {
        source: 'transactions',
        institution: 'Chase',
        account: 'Checking ****1234',
        transactionId: 'txn-9',
      },
    },
    {
      label: 'documents',
      path: buildDocumentMatch(
        {
          id: 'd-1',
          source: 'obsidian',
          externalId: 'ext-1',
          title: 'Andy Notes',
          url: null,
          content: 'Andy',
          metadata: { vault: 'main', path: 'Projects/Andy.md' },
          sourceUpdatedAt: new Date('2026-05-11T22:53:13.642Z'),
          updatedAt: new Date('2026-05-11T22:53:13.642Z'),
        } as never,
        INPUT
      ).path,
      expect: {
        source: 'documents',
        documentSource: 'obsidian',
        rest: 'main/Projects/Andy.md',
      },
    },
  ];

  for (const { label, path, expect } of emitted) {
    const parsed = parseGrepPath(path);
    assert.notEqual(parsed, null, `${label}: emitted path ${path} did not parse`);
    assert.deepEqual(parsed, expect, `${label}: ${path}`);
  }
});

console.log('grep path round-trip invariant holds');
