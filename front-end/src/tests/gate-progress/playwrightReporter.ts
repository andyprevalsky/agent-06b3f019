/**
 * Playwright reporter for the DEPLOY_GATE_PROGRESS protocol (see ./gateProgress.ts).
 *
 *   onTestEnd(test, result)
 *     ├─ passed / skipped, or the expected outcome ──> nothing
 *     ├─ failed but a retry remains ─────────────────> nothing (the retry decides)
 *     └─ final attempt failed ──> FAIL row, scope "test",
 *                                 unit "<file relative to the config dir> > <describe > … > title>"
 *
 * Enabled only when DEPLOY_GATE_PROGRESS is set: playwright.config.ts appends it to its reporters,
 * and front-end/scripts/run-semantic-tests.sh appends it to the `--reporter=list` override the
 * semantic gate passes (a CLI --reporter replaces the config's list).
 */
import { dirname, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type {
  FullConfig,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from '@playwright/test/reporter';
import { reportGateProgress } from './gateProgress.ts';

type Env = Record<string, string | undefined>;

/** Stack then message (the tail survives the 2000-char cut), without terminal colors. */
function describeErrors(errors: ReadonlyArray<TestError>): string {
  return stripVTControlCharacters(
    errors
      .map((error) =>
        [error.stack ?? '', error.message ?? error.value ?? ''].filter(Boolean).join('\n'),
      )
      .join('\n\n'),
  );
}

export function playwrightUnit(test: TestCase, baseDir: string): string {
  const titles = [test.title];
  for (
    let suite: Suite | undefined = test.parent;
    suite?.type === 'describe';
    suite = suite.parent
  ) {
    titles.unshift(suite.title);
  }
  return `${relative(baseDir, test.location.file)} > ${titles.join(' > ')}`;
}

export default class GateProgressPlaywrightReporter implements Reporter {
  private baseDir = process.cwd();

  private readonly env: Env;

  // Playwright constructs reporters with their config options object, never an env.
  constructor(options: { env?: Env } = {}) {
    this.env = options.env ?? process.env;
  }

  onBegin(config: FullConfig): void {
    this.baseDir = config.configFile ? dirname(config.configFile) : config.rootDir;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'passed' || result.status === 'skipped') return;
    if (result.status === test.expectedStatus) return; // test.fail() that failed as declared
    // Playwright retries a failed attempt while retries remain (never an interrupted one);
    // only the final attempt is the test's verdict.
    if (result.status !== 'interrupted' && result.retry < test.retries) return;
    reportGateProgress(
      playwrightUnit(test, this.baseDir),
      'FAIL',
      { scope: 'test', detail: describeErrors(result.errors) },
      this.env,
    );
  }

  printsToStdio(): boolean {
    return false;
  }
}
