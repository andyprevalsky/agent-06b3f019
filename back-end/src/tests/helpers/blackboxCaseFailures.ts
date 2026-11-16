import { AssertionError } from 'node:assert';
import { isDeepStrictEqual } from 'node:util';

type Action = (...args: never[]) => unknown;

export interface BlackboxCaseFailure {
  readonly name: string;
  readonly action: Action;
  readonly stage: 'action' | 'contract';
  readonly error: unknown;
}

export class BlackboxCaseFailures extends AggregateError {
  readonly failures: ReadonlyArray<BlackboxCaseFailure>;

  constructor(failures: ReadonlyArray<BlackboxCaseFailure>) {
    super(
      failures.map((failure) => failure.error),
      failures
        .map(
          ({ name, error }) =>
            `${name}: ${error instanceof Error ? error.message : 'Assertion failed'}`
        )
        .join('\n')
    );
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
  }
}

/** Collect failures while still running every case and its provider-contract check. */
export class BlackboxCaseResults {
  passed = 0;
  failed = 0;
  private readonly failures: BlackboxCaseFailure[] = [];

  constructor(private readonly report: (passed: boolean, name: string, error?: unknown) => void) {}

  async run(
    name: string,
    identity: Action,
    action: () => Promise<void>,
    checkContract?: () => void | Promise<void>
  ): Promise<void> {
    const failures: BlackboxCaseFailure[] = [];
    try {
      await action();
    } catch (error) {
      failures.push({ name, action: identity, stage: 'action', error });
    }
    try {
      await checkContract?.();
    } catch (error) {
      failures.push({ name, action: identity, stage: 'contract', error });
    }
    if (failures.length) {
      this.failed++;
      this.failures.push(...failures);
      for (const failure of failures) this.report(false, name, failure.error);
    } else {
      this.passed++;
      this.report(true, name);
    }
  }

  throwFailures(): void {
    if (this.failures.length) throw new BlackboxCaseFailures(this.failures);
  }
}

export interface KnownCaseAssertion {
  readonly name: string;
  readonly action: Action;
  readonly operator: string;
  readonly actual: unknown;
  readonly expected: unknown;
}

/** An aggregate is eligible only when every failure matches an original callback and exact assertion. */
export function onlyKnownCaseAssertions(
  error: unknown,
  known: ReadonlyArray<KnownCaseAssertion>
): boolean {
  return (
    error instanceof BlackboxCaseFailures &&
    error.failures.length > 0 &&
    error.failures.every(
      (failure) =>
        failure.stage === 'action' &&
        failure.error instanceof AssertionError &&
        known.some(
          (entry) =>
            failure.action === entry.action &&
            failure.name === entry.name &&
            (failure.error as AssertionError).operator === entry.operator &&
            isDeepStrictEqual((failure.error as AssertionError).actual, entry.actual) &&
            isDeepStrictEqual((failure.error as AssertionError).expected, entry.expected)
        )
    )
  );
}
