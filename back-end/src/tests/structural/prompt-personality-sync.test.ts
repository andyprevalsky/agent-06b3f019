#!/usr/bin/env tsx
/**
 * Structural test: the SMS supervisor shares the main agent's personality.
 *
 * The supervisor prompt (providers/smsSupervisor/contextBuilder.ts) reuses
 * two paragraphs verbatim from the Python main-agent prompt
 * (agents/utils/prompts.py MAIN_SYSTEM_PROMPT) so there is ONE personality
 * across surfaces. This test reads both files and fails if the shared block
 * drifts in either direction. Whitespace is normalized because the Python
 * source hard-wraps lines inside the f-string.
 */

import * as fs from 'fs';
import * as path from 'path';

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const SUPERVISOR_PROMPT_PATH = path.join(
  BACKEND_ROOT,
  'src/providers/smsSupervisor/contextBuilder.ts'
);
const MAIN_AGENT_PROMPT_PATH = path.join(BACKEND_ROOT, '../agents/utils/prompts.py');

// The shared personality block, whitespace-normalized. Update BOTH prompt
// files together if this personality ever changes.
const SHARED_PERSONALITY_PARAGRAPHS = [
  'Operate with the lowest energy expenditure possible. Each tool invocation consumes ' +
    'human attention, social credibility, or monetary capital. Behave like a world-class COO: ' +
    "make reasonable assumptions, don't get blocked, move forward, MAJOR bias towards action. " +
    'You specialize in real-world, long-horizon task execution. The task is not complete unless ' +
    'the goal is entirely accomplished with no further actions required from the user.',
  'Irreversible, external, destructive, and privacy-sensitive actions 100% ARE allowed, ' +
    'that is because you are in a harness that automatically detects those behaviors and ' +
    'escalates them for human approval. This is to allow you to bias completely towards action ' +
    'with the confidence that an external entity will ensure any attempted actions are safe, ' +
    'asking for permission in this case is much worse than asking for forgiveness.',
];

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function runCheck(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++;
    out(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${detail}`);
    out(`  FAIL ${name} — ${detail}`);
  }
}

out('── SMS supervisor ↔ main agent personality sync ──');

const supervisorSource = normalize(fs.readFileSync(SUPERVISOR_PROMPT_PATH, 'utf8'));

if (!fs.existsSync(MAIN_AGENT_PROMPT_PATH)) {
  // agents/ is always present in this monorepo checkout; a missing file means
  // the path moved — fail loudly rather than skip.
  runCheck(
    'agents/utils/prompts.py exists',
    false,
    `expected main-agent prompt at ${MAIN_AGENT_PROMPT_PATH}`
  );
} else {
  const mainAgentSource = normalize(fs.readFileSync(MAIN_AGENT_PROMPT_PATH, 'utf8'));
  for (const [i, paragraph] of SHARED_PERSONALITY_PARAGRAPHS.entries()) {
    const expected = normalize(paragraph);
    runCheck(
      `shared paragraph ${i + 1} present in SMS supervisor prompt`,
      supervisorSource.includes(expected),
      'supervisor prompt drifted from the shared personality block'
    );
    runCheck(
      `shared paragraph ${i + 1} present in main agent prompt (prompts.py)`,
      mainAgentSource.includes(expected),
      'main agent prompt drifted from the shared personality block'
    );
  }
}

out(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  for (const f of failures) out(`  ${f}`);
  process.exit(1);
}
out('prompt personality sync structural tests passed');
