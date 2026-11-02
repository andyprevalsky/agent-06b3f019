#!/usr/bin/env tsx
/** Regression test: direct plan/execute agents must honor task_queue overrides. */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src/domains/agents/agentDirectStartService.ts'),
  'utf8'
);
const descendantSource = readFileSync(
  join(process.cwd(), 'src/domains/agents/agentDescendantStartService.ts'),
  'utf8'
);

const directWorkflowMatch = source.match(
  /async function startDirectWorkflow[\s\S]*?startAgentWorkflowExecution\(\{([\s\S]*?)\n {2}\}\);/
);
assert.ok(
  directWorkflowMatch,
  'startDirectWorkflow startAgentWorkflowExecution params should be found'
);
assert.match(
  directWorkflowMatch[1],
  /\.\.\.\(body\.task_queue !== undefined \? \{ taskQueue: body\.task_queue \} : \{\}\),/,
  'startDirectWorkflow should pass body.task_queue through as taskQueue'
);

const subAgentWorkflowMatch = descendantSource.match(
  /async function startSubAgentWorkflow[\s\S]*?const params = \{([\s\S]*?)\n {2}\};/
);
assert.ok(subAgentWorkflowMatch, 'startSubAgentWorkflow durable start params should be found');
assert.match(
  subAgentWorkflowMatch[1],
  /\.\.\.\(body\.task_queue !== undefined \? \{ taskQueue: body\.task_queue \} : \{\}\),/,
  'startSubAgentWorkflow should keep passing body.task_queue through as taskQueue'
);
assert.match(
  descendantSource,
  /\(deadlineAtMs\) => startAgentWorkflowExecution\(params, deadlineAtMs\)/,
  'startSubAgentWorkflow should pass its durable-start deadline to Temporal'
);

process.stdout.write('  ✅ direct and durable descendant task_queue overrides are wired\n');
