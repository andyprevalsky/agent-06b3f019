/**
 * Playwright reporter for the DEPLOY_GATE_PROGRESS protocol (see ./gateProgress.ts).
 *
 *   onTestEnd(test, result)
 *     ├─ passed on a retry (result.retry > 0) ───────> FLAKY row (attempts = retry + 1) +
 *     │                                                TEST_FLAKY stdout line
 *     ├─ passed / skipped, or the expected outcome ──> nothing
 *     ├─ failed but a retry remains ─────────────────> nothing (the retry decides)
 *     └─ final attempt failed ──> FAIL row, scope "test",
 *                                 unit "<file relative to the config dir> > <describe > … > title>"
 *
 * Enabled only when DEPLOY_GATE_PROGRESS is set: playwright.config.ts appends it to its reporters,
 * and front-end/scripts/run-semantic-tests.sh appends it to the `--reporter=list` override the
 * semantic gate passes (a CLI --reporter replaces the config's list). The same condition sets
 * `retries: 1` in playwright.config.ts, so local runs keep zero retries.
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
import { reportGateProgress, reportVisibleGateProgress } from './gateProgress.ts';

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

  // The failed attempt's errors, kept until its retry passes (the FLAKY row's detail).
  private readonly firstErrors = new Map<string, ReadonlyArray<TestError>>();

  private readonly write: ((line: string) => void) | undefined;

  // Playwright constructs reporters with their config options object, never an env.
  constructor(options: { env?: Env; write?: (line: string) => void } = {}) {
    this.env = options.env ?? process.env;
    this.write = options.write;
  }

  onBegin(config: FullConfig): void {
    this.baseDir = config.configFile ? dirname(config.configFile) : config.rootDir;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'passed' && result.retry > 0) {
      // Not a free pass: the deploy requires /RCA attribution for a retried-then-passed test.
      reportVisibleGateProgress(
        playwrightUnit(test, this.baseDir),
        'FLAKY',
        {
          scope: 'test',
          detail: describeErrors(this.firstErrors.get(test.id) ?? []),
          attempts: result.retry + 1,
        },
        this.env,
        this.write,
      );
      this.firstErrors.delete(test.id);
      return;
    }
    if (result.status === 'passed' || result.status === 'skipped') return;
    if (result.status === test.expectedStatus) return; // test.fail() that failed as declared
    // Playwright retries a failed attempt while retries remain (never an interrupted one);
    // only the final attempt is the test's verdict.
    if (result.status !== 'interrupted' && result.retry < test.retries) {
      if (!this.firstErrors.has(test.id)) this.firstErrors.set(test.id, result.errors);
      return;
    }
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
