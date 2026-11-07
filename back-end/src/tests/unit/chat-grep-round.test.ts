#!/usr/bin/env tsx

/**
 * Behavior of one chat grep round, with persistence and the grep executor
 * recorded instead of called:
 * - the Router's grep arguments reach the shared executor once, with the
 *   chat's userId and its agentId (agent_network is that agent's tree), and
 *   strict-provider nulls are dropped before they get there;
 * - rows land in order: reasoning, IN_PROGRESS chip, FINISHED result whose
 *   text names the call so the next route and the Generator can read it;
 * - an executor failure still terminalizes the chip as an ERROR row;
 * - card titles follow the explore agent's grep titles.
 */

import assert from 'node:assert';
import 'dotenv/config';

import {
  formatGrepTitle,
  runChatGrepRound,
  type ChatGrepRoundDeps,
  type GrepDecision,
} from '../../providers/chat/chatGrepRound';
import { parseRouterDecisionJson } from '../../providers/chat/routerDecision';

type Row = { role: string; text: string; metadata?: Record<string, unknown> };
type Call = { userId: string; args: Record<string, unknown>; agentId?: string };

function recorder(options: { fail?: boolean } = {}) {
  const rows: Row[] = [];
  const calls: Call[] = [];
  const broadcasts: Array<{ toolName: string; status: string; title: string }> = [];
  const deps = {
    createMessage: async (input: Row) => {
      rows.push({ role: input.role, text: input.text, metadata: input.metadata });
      return {};
    },
    broadcastToolEvent: async (
      _agentId: string,
      _streamId: string,
      _toolCallId: string,
      toolName: string,
      status: string,
      title: string
    ) => {
      broadcasts.push({ toolName, status, title });
    },
    executeUserDataGrepTool: async (
      userId: string,
      args: Record<string, unknown>,
      context: { agentId?: string } = {}
    ) => {
      calls.push({ userId, args, agentId: context.agentId });
      if (options.fail) throw new Error("Unsupported grep parameter: 'filters.calendar'.");
      return {
        matches: [{ source: 'calendar', path: 'calendar/a@x.com/2026-11-03', content: 'Dentist' }],
        total_matches: 1,
        truncated: false,
        pattern: String(args.pattern ?? ''),
        sources: ['calendar'],
        applied_limit: 20,
        applied_offset: 0,
        returned: 1,
        has_more: false,
        next_offset: null,
      };
    },
  } as unknown as ChatGrepRoundDeps;
  return { deps, rows, calls, broadcasts };
}

/** A grep decision exactly as a strict provider's router JSON parses. */
function decision(): GrepDecision {
  const parsed = parseRouterDecisionJson(
    JSON.stringify({
      reasoning: 'the appointment is in their calendar',
      action: 'grep',
      queries: [],
      goal: '',
      mode: 'plan',
      grep: { pattern: 'dentist', sources: ['calendar'], head_limit: null, filters: null },
    })
  );
  assert.equal(parsed.action, 'grep');
  return parsed as GrepDecision;
}

async function main(): Promise<void> {
  {
    const { deps, rows, calls, broadcasts } = recorder();
    await runChatGrepRound(
      { agentId: 'agent-1', userId: 'user-1', decision: decision(), routerStreamId: 'router-1' },
      deps
    );
    assert.deepEqual(calls, [
      { userId: 'user-1', agentId: 'agent-1', args: { pattern: 'dentist', sources: ['calendar'] } },
    ]);
    assert.deepEqual(
      rows.map((row) => [row.role, row.metadata?.toolStatus ?? null]),
      [
        ['ASSISTANT', null],
        ['TOOL', 'IN_PROGRESS'],
        ['TOOL', 'FINISHED'],
      ]
    );
    assert.equal(rows[0].text, 'the appointment is in their calendar');
    assert.equal(rows[0].metadata?.streamId, 'router-1');
    const [, chip, finished] = rows;
    assert.equal(chip.text, '', 'the IN_PROGRESS chip carries no model-visible text');
    assert.equal(chip.metadata?.toolName, 'grep');
    assert.equal(chip.metadata?.title, 'Searching calendar for "dentist"');
    assert.equal(finished.metadata?.toolCallId, chip.metadata?.toolCallId);
    assert.equal(finished.metadata?.title, 'Searched calendar for "dentist"');
    assert.equal(finished.metadata?.subAgentId, undefined, 'chat context must keep the row');
    assert.match(finished.text, /^Grep \{"pattern":"dentist","sources":\["calendar"\]\}\n\n/);
    assert.equal(JSON.parse(finished.text.split('\n\n')[1]).matches[0].content, 'Dentist');
    assert.deepEqual(broadcasts, [
      { toolName: 'grep', status: 'IN_PROGRESS', title: 'Searching calendar for "dentist"' },
    ]);
  }

  {
    const { deps, rows } = recorder({ fail: true });
    await runChatGrepRound(
      { agentId: 'agent-2', userId: 'user-2', decision: decision(), routerStreamId: 'router-2' },
      deps
    );
    const terminal = rows.at(-1);
    assert.equal(terminal?.metadata?.toolStatus, 'ERROR');
    assert.equal(terminal?.metadata?.error, true);
    assert.equal(terminal?.metadata?.title, 'Grep failed searching calendar for "dentist"');
    assert.match(terminal?.text ?? '', /\n\nError: Unsupported grep parameter/);
  }

  assert.equal(formatGrepTitle('Searching', {}), 'Searching all local data for all messages');
  assert.equal(
    formatGrepTitle('Searching', { source: 'messages' }),
    'Searching messages for all messages'
  );
  assert.equal(
    formatGrepTitle('Searching', { sources: ['agent_trajectories'], role: 'USER' }),
    'Searching agent trajectories'
  );
  assert.equal(
    formatGrepTitle('Searching', { pattern: 'x'.repeat(100), filters: { drive: { path: 'p' } } }),
    `Searching drive for "${'x'.repeat(77)}..."`
  );

  process.stdout.write('chat-grep-round: all assertions passed\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
