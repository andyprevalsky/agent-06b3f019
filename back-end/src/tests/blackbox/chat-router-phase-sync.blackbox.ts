#!/usr/bin/env tsx
/**
 * Drift guard: the router prompt embeds copies of the agent's PLAN/EXECUTE
 * phase system prompts (PLAN_PHASE_PROMPT_MIRROR / EXECUTE_PHASE_PROMPT_MIRROR in
 * chatPrompts.ts). Those copies must stay byte-identical to the canonical source
 * in agents/utils/prompts.py. This test extracts the Python constants and asserts
 * they match the TS mirrors — if someone edits one phase prompt without the other,
 * this fails. It also asserts the router prompt actually embeds both mirrors and
 * that the structured-output `mode` field defers to the prompt's Mode Selection.
 * Every router stage (the first route, the route after a round of web searches,
 * and the route once the turn's search rounds are spent) must list exactly the
 * actions its structured-output schema allows.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import {
  PLAN_PHASE_PROMPT_MIRROR,
  EXECUTE_PHASE_PROMPT_MIRROR,
  ROUTER_AFTER_SEARCH_SYSTEM_PROMPT,
  ROUTER_SEARCH_BUDGET_SPENT_SYSTEM_PROMPT,
  ROUTER_SYSTEM_PROMPT,
} from '../../providers/chat/chatPrompts';
import {
  ROUTER_JSON_SCHEMA,
  ROUTER_SEARCH_BUDGET_SPENT_JSON_SCHEMA,
} from '../../providers/chat/routerDecisionJsonSchema';

const ROUTER_STAGE_PROMPTS = [
  ['ROUTER_SYSTEM_PROMPT', ROUTER_SYSTEM_PROMPT, ROUTER_JSON_SCHEMA],
  ['ROUTER_AFTER_SEARCH_SYSTEM_PROMPT', ROUTER_AFTER_SEARCH_SYSTEM_PROMPT, ROUTER_JSON_SCHEMA],
  [
    'ROUTER_SEARCH_BUDGET_SPENT_SYSTEM_PROMPT',
    ROUTER_SEARCH_BUDGET_SPENT_SYSTEM_PROMPT,
    ROUTER_SEARCH_BUDGET_SPENT_JSON_SCHEMA,
  ],
] as const;

/** The numbered actions under "# Available Actions". */
function listedActions(prompt: string): string[] {
  const section = prompt.split('# Available Actions')[1]?.split('\n# ')[0] ?? '';
  return [...section.matchAll(/^\d+\. (\w+) - /gm)].map((match) => match[1]);
}

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
    'every router stage prompt embeds both phase-prompt mirrors',
    () => {
      for (const [name, prompt] of ROUTER_STAGE_PROMPTS) {
        if (!prompt.includes(PLAN_PHASE_PROMPT_MIRROR)) {
          throw new Error(`${name} does not embed PLAN_PHASE_PROMPT_MIRROR`);
        }
        if (!prompt.includes(EXECUTE_PHASE_PROMPT_MIRROR)) {
          throw new Error(`${name} does not embed EXECUTE_PHASE_PROMPT_MIRROR`);
        }
      }
    },
  ],
  [
    'each router stage lists exactly the actions its schema allows',
    () => {
      for (const [name, prompt, schema] of ROUTER_STAGE_PROMPTS) {
        const listed = listedActions(prompt);
        const allowed = [...schema.properties.action.enum];
        if (JSON.stringify(listed) !== JSON.stringify(allowed)) {
          throw new Error(
            `${name} lists ${JSON.stringify(listed)} but its schema allows ${JSON.stringify(allowed)}`
          );
        }
      }
    },
  ],
  [
    'every router stage schema writes the escalation goal and mode directly after action',
    () => {
      // Order-keeping hosts generate in declared order. With `queries` right
      // after `action`, the live GLM failover wrote the re-plan brief into
      // `queries` and the stale first request into `goal` (FLAKY 6a3ec2af).
      for (const [name, , schema] of ROUTER_STAGE_PROMPTS) {
        const order = Object.keys(schema.properties);
        if (
          JSON.stringify(order.slice(0, 4)) !==
          JSON.stringify(['reasoning', 'action', 'goal', 'mode'])
        ) {
          throw new Error(
            `${name} schema declares ${JSON.stringify(order)}; goal and mode must follow action`
          );
        }
        if (JSON.stringify(schema.required) !== JSON.stringify(order)) {
          throw new Error(
            `${name} schema required ${JSON.stringify(schema.required)} must follow ${JSON.stringify(order)}`
          );
        }
      }
    },
  ],
  [
    'router Mode Selection prefers execute when in doubt and allows coding in execute',
    () => {
      for (const [name, prompt] of ROUTER_STAGE_PROMPTS) {
        for (const needle of [
          'When in doubt, prefer "execute".',
          'Research, browsing, coding, and multi-step work are fine in execute',
        ]) {
          if (!prompt.includes(needle)) {
            throw new Error(`${name} missing Mode Selection rule: ${needle}`);
          }
        }
        if (prompt.includes('prefer "plan"')) {
          throw new Error(`${name} still prefers plan when in doubt`);
        }
      }
    },
  ],
  [
    'router prompt defines closed output media and satisfaction as emission',
    () => {
      for (const [name, prompt] of ROUTER_STAGE_PROMPTS) {
        for (const needle of [
          'This surface cannot emit: images',
          'Describing where that representation exists',
          'A finished agent run does not shrink this rule',
        ]) {
          if (!prompt.includes(needle)) {
            throw new Error(`${name} missing capability contract: ${needle}`);
          }
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
