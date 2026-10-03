#!/usr/bin/env tsx
/**
 * Render runs the backend with NODE_ENV=production and no FLY_APP_NAME. LLM context dumps
 * hold full prompts (page content, user messages), so they must never be written there.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dumpLlmContext, updateLlmDump } from '../../providers/llmDump';

const agentId = `llm-dump-production-${process.pid}`;
const agentDir = path.resolve(__dirname, '../../../..', '.llm-dumps', agentId);
const payload = {
  call_site: 'llm_dump_production_test',
  agent_id: agentId,
  message_count: 1,
  messages: [{ role: 'user', content: 'private page text' }],
};
const originalNodeEnv = process.env.NODE_ENV;
const originalFlyApp = process.env.FLY_APP_NAME;

function restoreEnv(): void {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalFlyApp === undefined) delete process.env.FLY_APP_NAME;
  else process.env.FLY_APP_NAME = originalFlyApp;
}

try {
  delete process.env.FLY_APP_NAME;
  process.env.NODE_ENV = 'production';
  assert.equal(dumpLlmContext(payload), null, 'Render production must not write LLM dumps');
  assert.equal(fs.existsSync(agentDir), false, 'Render production must not create a dump dir');

  process.env.NODE_ENV = 'test';
  const dumpPath = dumpLlmContext(payload);
  assert.ok(dumpPath, 'non-production runs keep writing LLM dumps');
  assert.equal(path.dirname(dumpPath), agentDir);

  process.env.NODE_ENV = 'production';
  updateLlmDump(dumpPath, { extra: { response: 'private model output' } });
  assert.doesNotMatch(
    fs.readFileSync(dumpPath, 'utf8'),
    /private model output/,
    'Render production must not append to an existing dump'
  );
} finally {
  restoreEnv();
  fs.rmSync(agentDir, { recursive: true, force: true });
}
