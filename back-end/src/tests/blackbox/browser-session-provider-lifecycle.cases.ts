/** Registered shared production-provider lifecycle conformance. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
export async function runBrowserProviderLifecycleCases(): Promise<void> {
  for (const fixture of [
    './browser-session-service-worker.fixture.ts',
    './browser-session-native-cleanup.fixture.ts',
    './browser-session-resume-readiness.fixture.ts',
    './browser-session-provider-lifecycle.fixture.ts',
  ]) {
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL(fixture, import.meta.url))],
      {
        env: { ...process.env, CODE_SESSION_STORAGE_BACKEND: 'local' },
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    console.log(result.stdout);
  }
}
