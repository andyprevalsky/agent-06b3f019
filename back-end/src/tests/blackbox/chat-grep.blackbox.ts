#!/usr/bin/env tsx
/**
 * Chat's read-only retrieval boundary must expose and execute the same user-data
 * grep as explores. Production e388d514 asked for a laundromat near the user;
 * chat could neither consult their records nor route to grep.
 *
 * Router JSON -> validated grep -> existing data bridge (server identity)
 *            -> persisted tool evidence -> next Router / Generator context
 */
import assert from 'node:assert/strict';
import {
  parseRouterDecisionJson,
  requireRouterDecision,
} from '../../providers/chat/routerDecision';
import { ROUTER_JSON_SCHEMA } from '../../providers/chat/routerDecisionJsonSchema';
import { createClosedRouterActionDetector } from '../../providers/chat/routerJsonStream';
import { runChatWebSearchRound } from '../../providers/chat/chatWebSearchRound';
import { registerUserDataGrep } from '../../providers/userDataSearch';

async function main(): Promise<void> {
  const decision = parseRouterDecisionJson(
    JSON.stringify({
      action: 'grep',
      reasoning: 'Consult the user’s records before asking for known information.',
      grep: {
        pattern: 'laundry|laundromat',
        sources: ['documents'],
        '-i': true,
        head_limit: 2,
        offset: 0,
        filters: { document_source: 'apple_notes' },
      },
    })
  );
  assert.equal(decision.action, 'grep', 'chat must accept a user-data grep action');
  assert.ok(
    ROUTER_JSON_SCHEMA.properties.action.enum.includes('grep'),
    'provider schema must offer grep'
  );
  const seen: string[] = [];
  createClosedRouterActionDetector((action) => seen.push(action))('{"action":"grep"');
  assert.deepEqual(
    seen,
    ['grep'],
    'grep discards an ungrounded speculative reply as soon as detected'
  );
  assert.throws(
    () =>
      requireRouterDecision({
        finalized: { decision, fullJson: JSON.stringify(decision) },
        deadlineExpired: false,
        stage: 'search_budget_spent',
      }),
    /search budget/,
    'the existing turn budget also bounds grep'
  );
  const rows: Array<{ role: string; text: string; metadata?: Record<string, unknown> }> = [];
  const calls: unknown[] = [];
  registerUserDataGrep(async (userId, params) => {
    calls.push({ userId, params });
    return {
      pattern: params.pattern ?? '',
      sources: params.sources ?? [],
      matches: [
        {
          source: 'documents',
          path: 'documents/apple_notes/laundry',
          pointer: 'notes/laundry',
          timestamp: '2026-10-28T20:00:00Z',
          content: 'Local laundry: $4 wash, $1 dry.',
        },
      ],
      total_matches: 3,
      returned: 1,
      truncated: true,
      applied_limit: 2,
      applied_offset: 0,
      has_more: true,
      next_offset: 1,
      display_order: 'newest_first',
      context_unit: 'logical_line',
    };
  });
  const deps = {
    createMessage: async (row: {
      role: string;
      text: string;
      metadata?: Record<string, unknown>;
    }) => {
      rows.push(row);
      return {} as never;
    },
    broadcastToolEvent: async () => undefined,
    agentFastMode: async () => {
      throw new Error('grep must not read a shared demo cache');
    },
    executeWebSearch: async () => {
      throw new Error('private grep must not search the public web');
    },
  };
  await runChatWebSearchRound(
    {
      agentId: 'current-agent',
      userId: 'authenticated-user',
      decision,
      routerStreamId: 'router-stream',
    },
    deps
  );
  assert.deepEqual(
    calls,
    [
      {
        userId: 'authenticated-user',
        params: {
          pattern: 'laundry|laundromat',
          sources: ['documents'],
          '-i': true,
          head_limit: 2,
          offset: 0,
          filters: { document_source: 'apple_notes' },
          agent_id: 'current-agent',
        },
      },
    ],
    'grep must bind user/tree identity on the server and preserve selectors'
  );
  assert.deepEqual(
    rows.map((x) => x.role),
    ['ASSISTANT', 'TOOL', 'TOOL']
  );
  assert.equal(rows[1].metadata?.toolName, 'grep');
  assert.equal(rows[1].metadata?.toolStatus, 'IN_PROGRESS');
  assert.equal(rows[2].metadata?.toolName, 'grep');
  assert.equal(rows[2].metadata?.toolStatus, 'FINISHED');
  assert.match(rows[2].text, /Local laundry: \$4 wash, \$1 dry\./);
  assert.match(rows[2].text, /"next_offset":1/, 'pagination survives into model evidence');
  assert.equal(rows[1].metadata?.toolCallId, rows[2].metadata?.toolCallId);
  console.log(
    'PASS chat offers grep, binds server identity, executes the existing data bridge, and preserves evidence/pagination'
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
