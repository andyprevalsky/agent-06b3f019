import { z } from 'zod';
import { assert, assertStatus, request } from './codex-sandbox.support';
import {
  assertSmokeSettings,
  deleteSmokeParent,
  liveSessionSettings,
  smokeParentAgent,
} from './code-agent-settings-smoke.support';
import { waitForCodexOutput } from './codex-ws-output.support';
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const DEV_USER_ID = process.env.CODEX_BLACKBOX_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const apiKeyHeaders = () => ({ 'Content-Type': 'application/json', 'X-API-Key': API_KEY });
export async function testSmoke_codexRestrictedCommandHandoff() {
  assert(API_KEY !== '', 'BACKEND_API_KEY is required');
  const parent = await smokeParentAgent(DEV_USER_ID);
  let taskId: string | undefined;
  let closed = false;
  const schema = z
    .object({
      account_name: z.string().nullable(),
      command_status: z.enum(['succeeded', 'missing', 'unauthenticated']),
      exit_status: z.number().int(),
      raw_output: z.string(),
      rose_handoff: z.object({ status: z.literal('complete'), summary: z.string() }).strict(),
    })
    .strict();
  const jsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      account_name: { type: ['string', 'null'] },
      command_status: { type: 'string', enum: ['succeeded', 'missing', 'unauthenticated'] },
      exit_status: { type: 'integer' },
      raw_output: { type: 'string' },
      rose_handoff: {
        type: 'object',
        additionalProperties: false,
        properties: { status: { type: 'string', enum: ['complete'] }, summary: { type: 'string' } },
        required: ['status', 'summary'],
      },
    },
    required: ['account_name', 'command_status', 'exit_status', 'raw_output', 'rose_handoff'],
  };
  const goal =
    'Run exactly one shell command, `yc me --json`, and nothing else. Report whether it succeeded and the account name (hnid) printed. Do not install, log in, retry, inspect files, or run other commands. If missing or unauthenticated, report that result.';
  try {
    const created = await request(`${BASE_URL}/api/codex-code-session/create`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        agent_id: parent.agentId,
        user_id: DEV_USER_ID,
        goal: `${goal}\n\nResult handoff instructions:\nWrite the result handoff and validate it against the declared schema.\n\nResult JSON Schema for /home/user/.rose/handoff.json:\n${JSON.stringify(jsonSchema)}`,
      }),
    });
    assertStatus(created.status, 200, created.data);
    const body = created.data as { task_id: string; ws_url: string };
    taskId = body.task_id;
    const { events } = await waitForCodexOutput(body.ws_url, undefined, true);
    const commands = events.filter((event) => (event as { type?: string }).type === 'command') as {
      command?: string;
      item_id?: string;
      exit_code?: number;
      output?: string;
    }[];
    const unique = [...new Map(commands.map((event) => [event.item_id, event])).values()];
    assert(
      unique.length === 1,
      `Expected exactly one shell command, got ${JSON.stringify(unique)}`
    );
    assert(
      unique[0].command === "/bin/bash -lc 'yc me --json'" || unique[0].command === 'yc me --json',
      `Unexpected command: ${unique[0].command}`
    );
    assert(
      !events.some((event) => (event as { type?: string }).type === 'file_change'),
      'Agent modified a file'
    );
    assert(
      events.some((event) => {
        const e = event as { type?: string; status?: string };
        return e.type === 'goal' && e.status === 'complete';
      }),
      'Native goal did not complete'
    );
    console.log(
      `    ↳ restricted command settings ${assertSmokeSettings('codex', parent, await liveSessionSettings(body.ws_url, taskId))}`
    );
    const close = await request(`${BASE_URL}/api/codex-code-session/close`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ task_id: taskId }),
    });
    closed = true;
    assertStatus(close.status, 200, close.data);
    const handoff = (close.data as { handoff?: { status?: string; content?: string } }).handoff;
    assert(
      handoff?.status === 'present' && typeof handoff.content === 'string',
      'Missing native handoff'
    );
    const result = schema.parse(JSON.parse(handoff.content));
    assert(
      result.exit_status === unique[0].exit_code,
      'Reported exit status differs from SDK command'
    );
    assert(result.raw_output === unique[0].output, 'Reported output differs from SDK command');
    if (result.command_status === 'succeeded') {
      assert(result.exit_status === 0, 'Success requires exit zero');
      const output = JSON.parse(unique[0].output ?? '');
      assert(result.account_name === output.hnid, 'Account differs from real command output');
    } else {
      assert(
        result.exit_status !== 0 && result.account_name === null,
        'Failure outcome must be truthful'
      );
    }
  } finally {
    if (taskId && !closed)
      await request(`${BASE_URL}/api/codex-code-session/close`, {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: JSON.stringify({ task_id: taskId }),
      });
    await deleteSmokeParent(parent);
  }
}
