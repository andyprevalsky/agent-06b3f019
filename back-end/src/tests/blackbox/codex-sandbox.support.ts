import { CredentialExhaustionSkip } from './codex-credit-skip';

export interface TestResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
  duration: number;
}

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 400)}`
    );
  }
}

export async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data, headers: response.headers };
}

export async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    if (error instanceof CredentialExhaustionSkip) {
      // Not a failure: the third-party account is out of credits/quota. Report
      // as a loud SKIP so the deploy gate is not blocked by external funding.
      return {
        name,
        passed: true,
        skipped: true,
        skipReason: error.message,
        duration: Date.now() - start,
      };
    }
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}
