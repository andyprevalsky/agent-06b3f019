#!/usr/bin/env tsx
/* eslint-disable no-console */
/** Regression test: direct plan/execute agents must honor task_queue overrides. */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src/domains/agents/agentLifecycleService.ts'),
  'utf8'
);

const directWorkflowMatch = source.match(
  /async function startDirectWorkflow[\s\S]*?startAgentWorkflow\(\{([\s\S]*?)\n {2}\}\);/
);
assert.ok(directWorkflowMatch, 'startDirectWorkflow startAgentWorkflow params should be found');
assert.match(
  directWorkflowMatch[1],
  /\.\.\.\(body\.task_queue !== undefined \? \{ taskQueue: body\.task_queue \} : \{\}\),/,
  'startDirectWorkflow should pass body.task_queue through as taskQueue'
);

const subAgentWorkflowMatch = source.match(
  /async function startSubAgentWorkflow[\s\S]*?return startAgentWorkflow\(\{([\s\S]*?)\n {2}\}\);/
);
assert.ok(subAgentWorkflowMatch, 'startSubAgentWorkflow startAgentWorkflow params should be found');
assert.match(
  subAgentWorkflowMatch[1],
  /\.\.\.\(body\.task_queue !== undefined \? \{ taskQueue: body\.task_queue \} : \{\}\),/,
  'startSubAgentWorkflow should keep passing body.task_queue through as taskQueue'
);

console.log('  ✅ direct workflow task_queue override is wired');
