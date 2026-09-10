#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyMemoryDefault,
  applyMemoryInheritance,
} from '../../domains/agents/agentExecutionMode';
import { createAgentSchema } from '../../domains/agents/types';

const previousMode = process.env.BENCHMARK_MODE;
const previousIsolated = process.env.BENCHMARK_ISOLATED_RUN;

try {
  delete process.env.BENCHMARK_MODE;
  delete process.env.BENCHMARK_ISOLATED_RUN;

  const production = createAgentSchema.parse({ goal: 'production root' });
  applyMemoryDefault(production);
  assert.strictEqual(production.memory_enabled, true, 'production roots default memory on');

  const markedBenchmark = createAgentSchema.parse({ goal: 'marked benchmark root' });
  applyMemoryDefault(markedBenchmark, true);
  assert.strictEqual(markedBenchmark.memory_enabled, false, 'marked benchmark roots default off');

  process.env.BENCHMARK_MODE = 'true';
  const isolatedBenchmark = createAgentSchema.parse({ goal: 'isolated benchmark root' });
  applyMemoryDefault(isolatedBenchmark);
  assert.strictEqual(
    isolatedBenchmark.memory_enabled,
    false,
    'dedicated benchmark stacks default off'
  );

  const explicitBenchmarkOn = createAgentSchema.parse({
    goal: 'planner memory A/B on arm',
    memory_enabled: true,
  });
  applyMemoryDefault(explicitBenchmarkOn, true);
  assert.strictEqual(
    explicitBenchmarkOn.memory_enabled,
    true,
    'explicit benchmark A/B opt-in wins'
  );

  const child = createAgentSchema.parse({
    goal: 'benchmark child',
    parent_agent_id: '00000000-0000-4000-8000-000000000001',
    parent_workflow_id: 'workflow-parent',
  });
  applyMemoryInheritance(child, false);
  applyMemoryDefault(child, true);
  assert.strictEqual(child.memory_enabled, false, 'benchmark descendants inherit memory off');

  const smsStart = readFileSync(
    join(process.cwd(), 'src', 'providers', 'smsSupervisor', 'supervisorTools.startAgent.ts'),
    'utf8'
  );
  assert.ok(smsStart.includes('memoryEnabled: plannerMemoryEnabledByDefault()'));
  assert.ok(smsStart.includes('memoryEnabled: resolvedMemory'));

  const codexBridge = readFileSync(
    join(process.cwd(), '..', 'e2b-templates', 'codex-code', 'rose-bridge.mjs'),
    'utf8'
  );
  assert.ok(codexBridge.includes('memory_enabled: MEMORY_ENABLED'));
  assert.ok(codexBridge.includes('"X-Benchmark-Run": API_KEY'));

  console.log('planner-memory default tests passed');
} finally {
  if (previousMode === undefined) delete process.env.BENCHMARK_MODE;
  else process.env.BENCHMARK_MODE = previousMode;
  if (previousIsolated === undefined) delete process.env.BENCHMARK_ISOLATED_RUN;
  else process.env.BENCHMARK_ISOLATED_RUN = previousIsolated;
}
