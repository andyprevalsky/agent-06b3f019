/** Registered local provider regressions; no funded provider allocation. */
import { prisma } from '../../providers/database';
import { runBrowserOpaqueFrameCheckpointCase } from './browser-session-opaque-frame.cases';
import { runBrowserSettledSteelResumeCases } from './browser-session-resume-retry.cases';

async function run() {
  const previousProfile = process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED;
  const previousFetch = globalThis.fetch;
  process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED = 'false';
  globalThis.fetch = (async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('fixture forbids external network');
    }
    return previousFetch(input, init);
  }) as typeof fetch;
  try {
    if (!process.argv.includes('--settled-only')) await runBrowserOpaqueFrameCheckpointCase();
    if (!process.argv.includes('--opaque-only')) await runBrowserSettledSteelResumeCases();
  } finally {
    await prisma.$disconnect();
    globalThis.fetch = previousFetch;
    if (previousProfile === undefined) delete process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED;
    else process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED = previousProfile;
  }
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
