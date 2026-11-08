/**
 * Vitest reporter for the DEPLOY_GATE_PROGRESS protocol (see ./gateProgress.ts).
 *
 *   worker finishes a test ──> onTestCaseResult ──failed──> FAIL row, scope "test",
 *                                                           unit "<file> > <full test name>"
 *   worker finishes a file ──> onTestModuleEnd ──> PASS|FAIL row, scope "file", unit "<file>"
 *                                                  (FAIL also covers a file that never collected)
 *
 * vitest.config.ts adds `gateProgressVitestPlugin()` only when DEPLOY_GATE_PROGRESS is set. The
 * plugin appends this reporter to the reporters Vitest already resolved (the default/agent and
 * github-actions defaults, or any CLI --reporter), so the gate's console output is unchanged.
 */
import { stripVTControlCharacters } from 'node:util';
import { reportGateProgress } from './gateProgress.ts';

type Env = Record<string, string | undefined>;

// The parts of Vitest's reporter API this reporter reads, declared here: a type import from
// 'vitest/node' inside tsconfig.app.json's program changed how jest-dom's matchers resolve, so
// `toHaveStyle({ opacity: 1 })` stopped type-checking in the coverage gate (2026-11-07).
interface SerializedError {
  stack?: string;
  diff?: unknown;
  name?: string;
  message: string;
}
export interface VitestTestCase {
  fullName: string;
  module: { relativeModuleId: string };
  result(): { state: string; errors?: ReadonlyArray<SerializedError> };
}
export interface VitestTestModule {
  relativeModuleId: string;
  state(): string;
  ok(): boolean;
  errors(): ReadonlyArray<SerializedError>;
  children: { allTests(state: 'failed'): Iterable<{ fullName: string }> };
}
export interface VitestPluginContext {
  vitest: { config: { reporters: unknown[] } };
}

/** Stack, diff, then message (the tail survives the 2000-char cut), without terminal colors. */
function describeErrors(errors: ReadonlyArray<SerializedError> | undefined): string {
  return stripVTControlCharacters(
    (errors ?? [])
      .map((error) =>
        [
          error.stack ?? '',
          typeof error.diff === 'string' ? error.diff : '',
          `${error.name ?? 'Error'}: ${error.message}`,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n'),
  );
}

export class GateProgressVitestReporter {
  private readonly env: Env;

  constructor(options: { env?: Env } = {}) {
    this.env = options.env ?? process.env;
  }

  onTestCaseResult(testCase: VitestTestCase): void {
    const result = testCase.result();
    if (result.state !== 'failed') return;
    reportGateProgress(
      `${testCase.module.relativeModuleId} > ${testCase.fullName}`,
      'FAIL',
      { scope: 'test', detail: describeErrors(result.errors) },
      this.env,
    );
  }

  onTestModuleEnd(testModule: VitestTestModule): void {
    if (testModule.state() === 'skipped') return;
    const failedTests = [...testModule.children.allTests('failed')].map((test) => test.fullName);
    const detail = [
      describeErrors(testModule.errors()),
      failedTests.length ? `failed tests: ${failedTests.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    reportGateProgress(
      testModule.relativeModuleId,
      testModule.ok() ? 'PASS' : 'FAIL',
      { scope: 'file', detail },
      this.env,
    );
  }
}

/** Appends one GateProgressVitestReporter after Vitest resolves its reporters. */
export function gateProgressVitestPlugin(env: Env = process.env) {
  return {
    name: 'rose-deploy-gate-progress',
    configureVitest({ vitest }: Pick<VitestPluginContext, 'vitest'>): void {
      const reporters = vitest.config.reporters;
      if (reporters.some((reporter) => reporter instanceof GateProgressVitestReporter)) return;
      reporters.push(new GateProgressVitestReporter({ env }));
    },
  };
}
