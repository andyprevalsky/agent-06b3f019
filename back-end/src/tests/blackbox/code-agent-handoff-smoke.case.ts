/**
 * Real-CLI handoff contract for the E2B smokes (R3c). The goal carries the same
 * "Result JSON Schema for <path>" block the worker appends
 * (agents/domains/spawn_claude_code_agent/service.py:handoff_task_text), and
 * /close must return the handoff file the real CLI wrote.
 */
import { CODE_AGENT_HANDOFF_PATH } from '../../providers/codeAgentPrompt';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Keys sorted like the worker's json.dumps(..., sort_keys=True). */
const HANDOFF_SMOKE_SCHEMA = {
  additionalProperties: false,
  properties: {
    file: {
      additionalProperties: false,
      properties: { path: { description: 'ABSOLUTE file path starting with /.', type: 'string' } },
      required: ['path'],
      type: 'object',
    },
    sentinel: { description: 'The exact text you wrote into the output file.', type: 'string' },
  },
  required: ['sentinel', 'file'],
  type: 'object',
};

export function handoffSmokeGoal(goal: string): string {
  return `${goal}\n\nResult JSON Schema for ${CODE_AGENT_HANDOFF_PATH}:\n${JSON.stringify(HANDOFF_SMOKE_SCHEMA)}`;
}

/** The close response must carry the handoff the CLI wrote, matching the schema. */
export function assertSmokeHandoff(closeBody: unknown, sentinel: string, filePath: string): void {
  const handoff = (closeBody as { handoff?: { status?: string; content?: unknown } } | null)
    ?.handoff;
  assert(
    handoff?.status === 'present' && typeof handoff.content === 'string',
    `close returned no handoff file at ${CODE_AGENT_HANDOFF_PATH}: ${JSON.stringify(closeBody).slice(0, 500)}`
  );
  const parsed = JSON.parse(handoff.content) as Record<string, unknown>;
  assert(
    JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify(['file', 'sentinel']),
    `handoff keys do not match the schema: ${handoff.content.slice(0, 300)}`
  );
  assert(
    parsed.sentinel === sentinel,
    `handoff sentinel mismatch: ${handoff.content.slice(0, 300)}`
  );
  assert(
    JSON.stringify(parsed.file) === JSON.stringify({ path: filePath }),
    `handoff file mismatch: ${handoff.content.slice(0, 300)}`
  );
}
