/**
 * Benchmark check entrypoint (C16): a finished run's root-agent and code-agent
 * replies, and the code agent's command output, render as markdown structure.
 *
 * Unset AGENT_MARKDOWN_RUN_FILES: checks the checked-in prod run (root
 * 1a3d495c's Claude Code task 6f8f8f4d plus two real root replies), so /deploy
 * cements the check itself. A benchmark points it at its own finished run:
 *
 *   AGENT_MARKDOWN_RUN_FILES=<GET /api/agents/<id> body .json>[,<...>]
 *   AGENT_MARKDOWN_REQUIRE=root,code        (optional; fail when none found)
 *   AGENT_MARKDOWN_REPORT=<report .json>    (optional; {ok, checked, violations})
 *   npx vitest run src/tests/blackbox/agent-markdown-benchmark.blackbox.tsx
 *
 * front-end/scripts/check-agent-markdown.sh fetches the agent bodies and runs it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Message } from '@/lib/api';

import {
  agentRunFromJson,
  checkAgentMarkdownRuns,
  type AgentRun,
} from '../agent-markdown/agentMarkdownRun';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');
const ROOT_ID = '1a3d495c-826c-4eca-afe0-382fcbf72e82';

function rootReply(text: string, id: string): Message {
  return {
    message_id: id,
    timestamp: '2026-11-06T04:30:00.000Z',
    role: 'TOOL',
    text,
    metadata: {
      toolName: 'send_message_to_user',
      toolStatus: 'FINISHED',
      toolCallId: id,
      isUserAttentionMessage: true,
      attentionMessage: text,
    },
  };
}

/** The checked-in prod run: real code-agent rows and two real root replies. */
function prodFixtureRun(): AgentRun {
  const codeRows = JSON.parse(
    fixture('code-agent-markdown-prod-1a3d495c.fixture.json'),
  ) as Message[];
  return {
    agentId: ROOT_ID,
    messages: [
      ...codeRows,
      rootReply(fixture('agent-ddf91c56-table-reply.txt'), 'root-table'),
      rootReply(fixture('agent-0e16359e-headings-reply.txt'), 'root-headings'),
    ],
  };
}

function runsUnderTest(): AgentRun[] {
  const files = process.env.AGENT_MARKDOWN_RUN_FILES?.split(',').filter(Boolean) ?? [];
  if (files.length === 0) return [prodFixtureRun()];
  return files.map((file) =>
    agentRunFromJson(basename(file, '.json'), JSON.parse(readFileSync(file, 'utf8'))),
  );
}

describe('agent markdown benchmark check', () => {
  it('every root reply, code-agent reply and command output renders as structure', () => {
    const external = Boolean(process.env.AGENT_MARKDOWN_RUN_FILES);
    const require = (process.env.AGENT_MARKDOWN_REQUIRE ?? (external ? '' : 'root,code')).split(
      ',',
    );
    const report = checkAgentMarkdownRuns(runsUnderTest(), {
      requireRootReply: require.includes('root'),
      requireCodeReply: require.includes('code'),
    });
    if (process.env.AGENT_MARKDOWN_REPORT) {
      writeFileSync(process.env.AGENT_MARKDOWN_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    }
    expect(report.violations).toEqual([]);
    if (!external) expect(report.checked).toEqual({ root: 2, code: 2, output: 3 });
  });

  it('reports a missing code-agent reply and refuses paginated agent bodies', () => {
    const rootOnly = { agentId: 'root', messages: [rootReply('**done**', 'r1')] };
    expect(checkAgentMarkdownRuns([rootOnly], { requireCodeReply: true })).toEqual({
      ok: false,
      checked: { root: 1, code: 0, output: 0 },
      violations: [
        {
          agent_id: 'root',
          message_id: '',
          kind: 'missing',
          problems: ['no code agent reply found'],
        },
      ],
    });
    expect(() => agentRunFromJson('a', { messages: [], pagination: { has_more: true } })).toThrow(
      'a: messages are paginated',
    );
  });
});
