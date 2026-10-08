#!/usr/bin/env tsx
/**
 * Drift guard: the router prompt embeds copies of the agent's PLAN/EXECUTE
 * phase system prompts (PLAN_PHASE_PROMPT_MIRROR / EXECUTE_PHASE_PROMPT_MIRROR in
 * chatPrompts.ts). Those copies must stay byte-identical to the canonical source
 * in agents/utils/prompts.py. This test extracts the Python constants and asserts
 * they match the TS mirrors — if someone edits one phase prompt without the other,
 * this fails. It also asserts the router prompt actually embeds both mirrors and
 * that the structured-output `mode` field defers to the prompt's Mode Selection.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import {
  PLAN_PHASE_PROMPT_MIRROR,
  EXECUTE_PHASE_PROMPT_MIRROR,
  ROUTER_SYSTEM_PROMPT,
} from '../../providers/chat/chatPrompts';
import { ROUTER_JSON_SCHEMA } from '../../providers/chat/routerDecisionJsonSchema';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function runTest(name: string, fn: () => Promise<void> | void): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
      duration: Date.now() - start,
    };
  }
}

// Repo root is four levels up from src/tests/blackbox.
const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../../../..');
const PROMPTS_PY = resolve(REPO_ROOT, 'agents/utils/prompts.py');

/** Extract a top-level `NAME = """..."""` triple-quoted Python string, stripped. */
function extractPythonTripleQuoted(source: string, name: string): string {
  const re = new RegExp(`^${name} = """([\\s\\S]*?)"""`, 'm');
  const m = source.match(re);
  if (!m) throw new Error(`Could not find ${name} in ${PROMPTS_PY}`);
  return m[1].trim();
}

const tests: Array<[string, () => Promise<void> | void]> = [
  [
    'PLAN_PHASE_PROMPT_MIRROR matches agents/utils/prompts.py PLAN_PHASE_PROMPT',
    () => {
      const py = readFileSync(PROMPTS_PY, 'utf-8');
      const canonical = extractPythonTripleQuoted(py, 'PLAN_PHASE_PROMPT');
      if (PLAN_PHASE_PROMPT_MIRROR.trim() !== canonical) {
        throw new Error(
          'PLAN phase prompt drift: chatPrompts.ts mirror != agents/utils/prompts.py. ' +
            'Edit BOTH together.'
        );
      }
    },
  ],
  [
    'EXECUTE_PHASE_PROMPT_MIRROR matches agents/utils/prompts.py EXECUTE_PHASE_PROMPT',
    () => {
      const py = readFileSync(PROMPTS_PY, 'utf-8');
      const canonical = extractPythonTripleQuoted(py, 'EXECUTE_PHASE_PROMPT');
      if (EXECUTE_PHASE_PROMPT_MIRROR.trim() !== canonical) {
        throw new Error(
          'EXECUTE phase prompt drift: chatPrompts.ts mirror != agents/utils/prompts.py. ' +
            'Edit BOTH together.'
        );
      }
    },
  ],
  [
    'router mode field defers to the Mode Selection section',
    () => {
      const description = ROUTER_JSON_SCHEMA.properties.mode.description;
      if (!ROUTER_SYSTEM_PROMPT.includes('# Mode Selection')) {
        throw new Error('ROUTER_SYSTEM_PROMPT has no "# Mode Selection" section');
      }
      if (!description.includes('Mode Selection')) {
        throw new Error(
          `mode description must defer to Mode Selection instead of its own rule: "${description}"`
        );
      }
    },
  ],
  [
    'router prompt embeds both phase-prompt mirrors',
    () => {
      if (!ROUTER_SYSTEM_PROMPT.includes(PLAN_PHASE_PROMPT_MIRROR)) {
        throw new Error('ROUTER_SYSTEM_PROMPT does not embed PLAN_PHASE_PROMPT_MIRROR');
      }
      if (!ROUTER_SYSTEM_PROMPT.includes(EXECUTE_PHASE_PROMPT_MIRROR)) {
        throw new Error('ROUTER_SYSTEM_PROMPT does not embed EXECUTE_PHASE_PROMPT_MIRROR');
      }
    },
  ],
  [
    'router prompt defines closed output media and satisfaction as emission',
    () => {
      for (const needle of [
        'This surface cannot emit: images',
        'Describing where that representation exists',
        'A finished agent run does not shrink this rule',
      ]) {
        if (!ROUTER_SYSTEM_PROMPT.includes(needle)) {
          throw new Error(`ROUTER_SYSTEM_PROMPT missing capability contract: ${needle}`);
        }
      }
    },
  ],
];

async function main(): Promise<void> {
  const results: TestResult[] = [];
  for (const [name, fn] of tests) {
    results.push(await runTest(name, fn));
  }

  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    process.stdout.write(`${status} ${result.name} (${result.duration}ms)\n`);
    if (result.error) process.stderr.write(`${result.error}\n`);
  }

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} tests passed\n`);
  if (failed.length > 0) process.exit(1);
}

void main();
