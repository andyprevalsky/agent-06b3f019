#!/usr/bin/env tsx
/**
 * Stack teardown: kill every E2B sandbox tagged with this stack's identity
 * (providers/codeSessions/sandboxReaper.ts). run.sh calls it before dropping a
 * database it owns, and the blackbox runner on exit, so a dropped stack never
 * leaves paused sandboxes nobody can attribute. Never fails the teardown.
 *
 * Refuses a non-local DATABASE_URL unless ROSE_SANDBOX_STACK_ID names the stack
 * explicitly: a laptop pointed at the production database must not act on it.
 */
import 'dotenv/config';
import { roseSandboxIdentity } from '../src/providers/e2bSandboxCreate';
import { killStackSandboxes } from '../src/providers/codeSessions/sandboxReaper';

function localDatabase(): boolean {
  try {
    const host = new URL(process.env.DATABASE_URL ?? '').hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { roseStack } = roseSandboxIdentity();
  if (!process.env.ROSE_SANDBOX_STACK_ID?.trim() && !localDatabase()) {
    console.error(`kill-stack-sandboxes: refusing non-local stack ${roseStack}`);
    return;
  }
  if (!process.env.E2B_API_KEY) {
    console.log('kill-stack-sandboxes: no E2B_API_KEY; nothing to do');
    return;
  }
  const killed = await killStackSandboxes();
  console.log(`kill-stack-sandboxes: killed ${killed} sandbox(es) of ${roseStack}`);
}

main()
  .catch((error: unknown) => {
    console.error(
      `kill-stack-sandboxes: ${error instanceof Error ? error.message : String(error)}`
    );
  })
  .finally(() => process.exit(0));
