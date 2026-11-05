#!/usr/bin/env tsx
/** Offline boundaries: real wake/restart producers, mocked persistence and Temporal. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function loadService(
  file: string,
  dependencies: Record<string, unknown>
): Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>> {
  const code = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '../../domains/agents', file), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }
  ).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name: string) => {
      if (name in dependencies) return dependencies[name];
      // Unused imports are inert; any invocation fails instead of reaching services.
      return new Proxy(
        {},
        {
          get: () => () => {
            throw new Error(`Unexpected dependency: ${name}`);
          },
        }
      );
    },
    module,
    module.exports
  );
  return module.exports as Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>;
}

async function main(): Promise<void> {
  for (const mode of ['browser', 'execute', 'plan']) {
    const starts: {
      workflowId: string;
      startPhase: string;
      goal: string;
      resumeState?: unknown;
    }[] = [];
    const agent = {
      id: 'root',
      userId: 'user',
      goal: 'raw task',
      model: 'rose-1-ultra',
      reasoningMaxTokens: 256,
      status: 'COMPLETED',
      temporalWorkflowId: 'prior',
      temporalFirstExecutionRunId: 'prior-run',
      verifier: { type: 'llm' },
      parentAgentId: null,
      parentWorkflowId: null,
      busId: 'root',
      depth: 0,
      priceLimitCents: 1000,
      fastModeCacheEnabled: false,
      memoryEnabled: false,
      worldModelMode: 'real',
      workflowStartPhase: mode,
      workflowMaxIterations: null,
      workflowContextGates: null,
    };
    const dependencies = {
      './repo': {
        findAgentWithVerifier: async () => agent,
        clearWorkflowForTerminalAgent: async () => ({ count: 1 }),
        updateAgent: async () => ({}),
      },
      '../../providers/temporal': {
        startAgentWorkflowExecution: async (params: {
          workflowId: string;
          startPhase: string;
          goal: string;
          resumeState?: unknown;
        }) => {
          starts.push(params);
          return { workflowId: params.workflowId };
        },
      },
      '../../providers/logger': { createLogger: () => ({ info() {}, warn() {}, error() {} }) },
      '../../providers/workflowGeneration': { acceptChatWorkflowExecution: async () => true },
      '../../providers/derivedRunState': { followUpRunStateUpdate: (goal: string) => ({ goal }) },
      './agentExecutionMode': { normalizeWorldModelMode: (mode: string) => mode },
      '../../providers/workflowReplacementStartAcceptance': {
        acceptStartedWorkflowReplacement: async () => {},
      },
    };
    const wake = loadService('agentWakeService.ts', dependencies);
    assert.equal((await wake.wakeFinishedAgent('root', 'followup', 'updated goal')).woke, true);
    assert.equal(starts[0].startPhase, 'execute');
    assert.equal(starts[0].goal, 'updated goal');
    const restart = loadService('agentRestartService.ts', dependencies);
    const resumeState = {
      max_iterations: null,
      context_gates: null,
      runtime_state: { browser_execution_mode: mode === 'browser' },
    };
    const result = await restart.startPreparedAgentWorkflowReplacement({
      agentId: 'root',
      userId: 'user',
      claim: { plannedWorkflowId: 'replacement', resumeState },
    });
    assert.equal(result.success, true);
    assert.equal(starts[1].startPhase, 'resume');
    assert.equal(starts[1].resumeState, resumeState);
    assert.equal(starts[1].goal, 'raw task');
  }
  process.stdout.write(
    'PASS: wake/restart use generic execution for ordinary modes and retired browser state\n'
  );
}
main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
