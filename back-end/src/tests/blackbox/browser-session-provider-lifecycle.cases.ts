/** Registered shared production-provider lifecycle conformance. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
export async function runBrowserProviderLifecycleCases(): Promise<void> {
  for (const fixture of [
    new URL('./browser-session-review-regressions.fixture.ts', import.meta.url),
    new URL('./browser-session-hydration-retry.fixture.cjs', import.meta.url),
    new URL('./browser-session-service-worker.fixture.ts', import.meta.url),
    new URL('./browser-session-native-cleanup.fixture.ts', import.meta.url),
    new URL('./browser-session-resume-readiness.fixture.ts', import.meta.url),
    new URL('./browser-session-provider-lifecycle.fixture.ts', import.meta.url),
  ]) {
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(fixture)],
      {
        env: { ...process.env, CODE_SESSION_STORAGE_BACKEND: 'local' },
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    console.log(result.stdout);
  }
}
