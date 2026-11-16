import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Outcome contract for the Claude Code E2B smoke (deploy.md 6c).
 *
 *   case fn ──ok──────────────────────────────► PASS
 *          ──ClaudeSmokeUserActionSkip──────► SKIP (credential | billing, with evidence)
 *          ──any other error────────────────► FAIL
 *
 *   summary: failed > 0 ─► exit 1 (FAILURES)
 *            skipped > 0 ─► exit 1 (SMOKE_SKIP_BANNER: never a pass)
 *            otherwise ──► exit 0
 *
 * scripts/run-deploy-semantic-stack.sh reads these exact lines from the domain log
 * and reports E2B_SMOKE_VERDICT PASS | SKIPPED | FAIL.
 */

export type SmokeUserAction = 'credential' | 'billing';

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  skipped?: { kind: SmokeUserAction; evidence: string };
  duration: number;
}

/** The marker the gate requires before it accepts a smoke PASS. */
export const SANDBOX_PROOF = 'CLAUDE_E2B_DONE observed from real E2B sandbox';
export const SMOKE_SKIP_BANNER = 'CLAUDE-CODE SMOKE SKIPPED -- USER ACTION REQUIRED (NOT A PASS)';

/** A smoke block only the user can fix (credential or billing): a loud SKIP, never a PASS. */
export class ClaudeSmokeUserActionSkip extends Error {
  readonly kind: SmokeUserAction;
  readonly evidence: string;

  constructor(kind: SmokeUserAction, evidence: string) {
    const oneLine = evidence.replace(/\s+/g, ' ').trim().slice(0, 300);
    super(`USER ACTION REQUIRED (${kind}): ${oneLine}`);
    this.kind = kind;
    this.evidence = oneLine;
  }
}

export async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    const duration = Date.now() - start;
    if (error instanceof ClaudeSmokeUserActionSkip) {
      return {
        name,
        passed: false,
        skipped: { kind: error.kind, evidence: error.evidence },
        duration,
      };
    }
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration,
    };
  }
}

export function resultLine(result: TestResult): string {
  if (result.skipped) {
    return (
      `  SKIP  ${result.name} -- USER ACTION REQUIRED (${result.skipped.kind}): ` +
      `${result.skipped.evidence} (${result.duration}ms)`
    );
  }
  const icon = result.passed ? '  PASS' : '  FAIL';
  return `${icon}  ${result.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`;
}

export function summarizeResults(results: TestResult[]): {
  passed: number;
  failed: number;
  skipped: number;
  exitCode: 0 | 1;
} {
  const skipped = results.filter((r) => r.skipped !== undefined).length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed - skipped;
  const summary = { passed, failed, skipped, exitCode: failed > 0 || skipped > 0 ? 1 : 0 } as const;
  const directory = process.env.BLACKBOX_TEST_ARTIFACT_DIR;
  if (
    directory &&
    process.env.BLACKBOX_TEST_DOMAIN === 'claude-code' &&
    process.env.BLACKBOX_SMOKE === '1'
  ) {
    writeFileSync(
      join(directory, `claude-code-completion-${process.pid}.json`),
      JSON.stringify({
        runId: process.env.BLACKBOX_TEST_RUN_ID,
        domain: 'claude-code',
        completedAt: Date.now(),
        results,
        summary,
      }),
      { flag: 'wx' }
    );
  }
  return summary;
}
