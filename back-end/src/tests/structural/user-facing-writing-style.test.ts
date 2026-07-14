#!/usr/bin/env tsx
/** Structural checks for output-scoped user-facing writing instructions. */

import * as fs from 'fs';
import * as path from 'path';
import { GENERATOR_JSON_SCHEMA } from '../../providers/chat/generatorLlm';
import { GENERATOR_SYSTEM_PROMPT } from '../../providers/chat/chatPrompts';
import { SMS_SURFACE_OVERLAY } from '../../providers/smsSupervisor/contextBuilder';
import { SUPERVISOR_RESPONSE_SCHEMA } from '../../providers/smsSupervisor/schema';
import { TOOL_SCHEMAS } from '../../providers/smsSupervisor/supervisorTools.schemas';
import { USER_FACING_WRITING_STYLE } from '../../providers/userFacingWritingPrompt';

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const PYTHON_STYLE_PATH = path.join(BACKEND_ROOT, '../agents/utils/user_facing_writing_prompt.py');

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function hasDescriptionContaining(value: unknown, expected: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasDescriptionContaining(item, expected));
  }
  if (typeof value !== 'object' || value === null) return false;

  const record = value as Record<string, unknown>;
  if (typeof record.description === 'string' && record.description.includes(expected)) {
    return true;
  }
  return Object.values(record).some((item) => hasDescriptionContaining(item, expected));
}

for (const rule of [
  'AVOID using em dashes',
  'AVOID rhetorical questions',
  'AVOID staccato, stop-start sentences',
  'AVOID markdown',
  'delve',
  'ever-evolving',
]) {
  check(USER_FACING_WRITING_STYLE.includes(rule), `Shared style is missing: ${rule}`);
}

check(
  !SMS_SURFACE_OVERLAY.includes(USER_FACING_WRITING_STYLE),
  'SMS style must not be injected into the general supervisor system prompt'
);
check(
  !GENERATOR_SYSTEM_PROMPT.includes(USER_FACING_WRITING_STYLE),
  'Chat style must not be injected into the general generator system prompt'
);

check(
  hasDescriptionContaining(SUPERVISOR_RESPONSE_SCHEMA, USER_FACING_WRITING_STYLE),
  'Live SMS send_user_message.message schema is missing the shared style'
);

const smsSendUserMessage = TOOL_SCHEMAS.find((tool) => tool.name === 'send_user_message');
const smsToolDescription = smsSendUserMessage?.parameters.properties.message?.description ?? '';
check(
  smsToolDescription.includes(USER_FACING_WRITING_STYLE),
  'SMS tool catalog send_user_message.message is missing the shared style'
);

const chatResponseDescription = GENERATOR_JSON_SCHEMA.properties.response.description;
check(
  chatResponseDescription.includes(USER_FACING_WRITING_STYLE),
  'Chat response field is missing the shared style'
);

const pythonSource = fs.readFileSync(PYTHON_STYLE_PATH, 'utf8');
const pythonStyleMatch = pythonSource.match(
  /USER_FACING_WRITING_STYLE = """([\s\S]*?)"""\n\n\ndef user_facing_text_description/
);
check(pythonStyleMatch !== null, 'Python mirrored style constant was not found');
check(
  pythonStyleMatch?.[1] === USER_FACING_WRITING_STYLE,
  'Python and TypeScript writing-style contracts differ'
);

process.stdout.write('User-facing writing-style structural tests passed\n');
