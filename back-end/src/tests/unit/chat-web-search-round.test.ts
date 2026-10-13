#!/usr/bin/env tsx

/**
 * Behavior of one chat web-search round, with its persistence and search
 * dependencies recorded instead of called:
 * - every unique query runs (50 in one round), at most four at a time;
 * - a search that throws reports an error result while the others keep theirs,
 *   and every IN_PROGRESS chip gets its FINISHED row;
 * - a failed Fast Mode lookup ends the round before any chip is persisted.
 */

import assert from 'node:assert';
import 'dotenv/config';

import {
  runChatWebSearchRound,
  type ChatWebSearchRoundDeps,
  type WebSearchDecision,
} from '../../providers/chat/chatWebSearchRound';

type Row = { role: string; text: string; metadata?: Record<string, unknown> };

type Recorder = {
  deps: ChatWebSearchRoundDeps;
  rows: Row[];
  searched: string[];
  maxInFlight: () => number;
};

function recorder(options: { failQuery?: string; failFastMode?: boolean }): Recorder {
  const rows: Row[] = [];
  const searched: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const deps = {
    createMessage: async (input: Row) => {
      rows.push({ role: input.role, text: input.text, metadata: input.metadata });
      return {};
    },
    broadcastToolEvent: async () => undefined,
    agentFastMode: async () => {
      if (options.failFastMode) throw new Error('fast mode lookup failed');
      return {
        enabled: false,
        goal: null,
        writeEnabled: false,
        rootAgentId: null,
        rootGoal: null,
        providerFastMode: false,
      };
    },
    executeWebSearch: async (query: string) => {
      searched.push(query);
      const order = searched.length;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (query === options.failQuery) throw new Error('cache read failed');
        return { answer: `found ${query}`, sources: [`https://example.com/${order}`] };
      } finally {
        inFlight -= 1;
      }
    },
  } as unknown as ChatWebSearchRoundDeps;
  return { deps, rows, searched, maxInFlight: () => peak };
}

function decision(queries: string[]): WebSearchDecision {
  return { action: 'web_search', reasoning: 'look it up', queries };
}

function toolRows(rows: Row[], status: string): Row[] {
  return rows.filter((row) => row.role === 'TOOL' && row.metadata?.toolStatus === status);
}

async function main(): Promise<void> {
  {
    const queries = Array.from({ length: 50 }, (_, index) => `query ${index + 1}`);
    const { deps, rows, searched, maxInFlight } = recorder({});
    await runChatWebSearchRound(
      {
        agentId: 'agent-fan-out',
        decision: decision([...queries, ' query 1 ']),
        routerStreamId: 'router-fan-out',
      },
      deps
    );
    assert.deepEqual([...searched].sort(), [...queries].sort(), 'every unique query runs once');
    assert.ok(maxInFlight() <= 4, `at most four searches in flight, saw ${maxInFlight()}`);
    assert.equal(toolRows(rows, 'IN_PROGRESS').length, 50, 'one chip row per query');
    assert.deepEqual(
      toolRows(rows, 'FINISHED').map((row) => row.metadata?.query),
      queries,
      'results persist in query order'
    );
  }

  {
    const { deps, rows } = recorder({ failQuery: 'b' });
    await runChatWebSearchRound(
      {
        agentId: 'agent-partial',
        decision: decision(['a', 'b', 'c']),
        routerStreamId: 'router-partial',
      },
      deps
    );
    const started = toolRows(rows, 'IN_PROGRESS').map((row) => row.metadata?.toolCallId);
    const finished = toolRows(rows, 'FINISHED');
    assert.deepEqual(
      finished.map((row) => row.metadata?.toolCallId),
      started,
      'every chip that started finishes, including the failed one'
    );
    assert.equal(finished[0].text, 'Web search: "a"\n\nfound a\n\nSources: https://example.com/1');
    assert.equal(
      finished[1].text,
      'Web search: "b"\n\nUnable to search at this time: cache read failed\n\nSources: ',
      'a failed search reports the standard search error result'
    );
    assert.deepEqual(finished[1].metadata?.sources, []);
    assert.equal(finished[2].text, 'Web search: "c"\n\nfound c\n\nSources: https://example.com/3');
  }

  {
    const { deps, rows, searched } = recorder({ failFastMode: true });
    await assert.rejects(
      runChatWebSearchRound(
        {
          agentId: 'agent-fast-mode',
          decision: decision(['a', 'b']),
          routerStreamId: 'router-fast-mode',
        },
        deps
      ),
      /fast mode lookup failed/
    );
    assert.deepEqual(rows, [], 'no reasoning or chip is persisted when Fast Mode cannot load');
    assert.deepEqual(searched, []);
  }

  {
    const { deps, rows } = recorder({});
    await runChatWebSearchRound(
      {
        agentId: 'agent-early',
        decision: decision(['a', 'b']),
        earlyToolCallId: 'early-call',
        routerStreamId: 'router-early',
      },
      deps
    );
    assert.equal(
      toolRows(rows, 'FINISHED')[0].metadata?.toolCallId,
      'early-call',
      'the first query reuses the chip announced while the Router streamed'
    );
  }

  process.stdout.write('chat-web-search-round: all assertions passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
  process.exitCode = 1;
});
