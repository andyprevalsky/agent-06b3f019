/** Clean installation images: no agent home, auth, browser state or conversation is copied. */
import { createSandboxWithRetry } from './e2bSandboxCreate';
import { shellQuote } from './codeSessions/sandboxFs';
import type { SandboxSize, SandboxProvider } from './codeSessions/sandboxSize';
import {
  readUserCodeTemplate,
  type TemplateRecipe,
  type TemplateVariant,
  type TemplateVariantDefinition,
} from './userCodeTemplates';

import { NATIVE_CLI_PATH } from './codeSessions/sandboxPaths';
export { NATIVE_CLI_PATH } from './codeSessions/sandboxPaths';
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const BUILDER_TIMEOUT_MS = 30 * 60_000;

interface BuilderSandbox {
  commands: {
    run(command: string, options: { timeoutMs: number; cwd: string }): Promise<unknown>;
  };
  createSnapshot(options: {
    name: string;
    mode: 'filesystem';
    retries: number;
  }): Promise<{ snapshotId: string }>;
  kill(): Promise<unknown>;
  sandboxId: string;
}

type CreateBuilder = (
  templateId: string,
  options: Parameters<typeof createSandboxWithRetry>[1],
  label: string
) => Promise<BuilderSandbox>;

/** The coordinator supplies a fresh operation-specific name, never a mutable latest alias. */
export async function buildNativeCliTemplate(
  recipes: TemplateRecipe[],
  variant: TemplateVariantDefinition,
  uniqueName: string,
  create: CreateBuilder = createSandboxWithRetry
): Promise<string> {
  const sandbox = await create(
    variant.baseTemplateId,
    {
      apiKey: process.env.E2B_API_KEY,
      timeoutMs: BUILDER_TIMEOUT_MS,
      envs: { HOME: '/home/user', PATH: NATIVE_CLI_PATH, LANG: 'C.UTF-8' },
      metadata: { purpose: 'native-cli-template-builder', operation: uniqueName },
    },
    'CLI template builder'
  );
  let phase = 'installation';
  let snapshotId: string | undefined;
  let failed = false;
  try {
    for (const recipe of recipes) {
      if (!recipe.command.startsWith('/') || recipe.command.includes('\0')) {
        throw new Error('Invalid executable path');
      }
      // A clean process environment prevents accidental inheritance even from base-image defaults.
      const run = (script: string, timeoutMs: number) =>
        sandbox.commands.run(
          `env -i HOME=/home/user PATH=${shellQuote(NATIVE_CLI_PATH)} LANG=C.UTF-8 bash --noprofile --norc -c ${shellQuote(`set -euo pipefail\n${script}`)}`,
          { timeoutMs, cwd: '/home/user' }
        );
      await run(recipe.install, INSTALL_TIMEOUT_MS);
      phase = 'installation verification';
      if (recipe.verify.some((arg) => arg.includes('\0'))) throw new Error('Invalid verification');
      await run(
        `test -x ${shellQuote(recipe.command)}\n${[recipe.command, ...recipe.verify].map(shellQuote).join(' ')}`,
        30_000
      );
      phase = 'installation';
    }
    phase = 'filesystem snapshot';
    // Never retry an ambiguous snapshot request or fall back to a memory snapshot.
    const snapshot = await sandbox.createSnapshot({
      name: uniqueName,
      mode: 'filesystem',
      retries: 0,
    });
    if (!snapshot.snapshotId) throw new Error('Snapshot identifier missing');
    snapshotId = snapshot.snapshotId;
  } catch {
    failed = true;
  }
  try {
    await sandbox.kill();
  } catch {
    // Keep identifiers for exact-owned cleanup, without leaking installer output or credentials.
    throw new Error(
      `CLI template builder cleanup failed: sandbox ${sandbox.sandboxId}${snapshotId ? `, snapshot ${snapshotId}` : ''}`
    );
  }
  if (failed || !snapshotId) throw new Error(`CLI template ${phase} failed`);
  return snapshotId;
}

export function selectNativeCliTemplate(
  variants: TemplateVariant[],
  provider: SandboxProvider,
  size: SandboxSize,
  baseTemplateId: string
): string {
  const variant = variants.find(
    (entry) =>
      entry.provider === provider &&
      entry.cpu === size.cpu &&
      entry.memoryGb === size.memoryGb &&
      entry.baseTemplateId === baseTemplateId
  );
  if (!variant?.snapshotId) {
    throw new Error(
      'The user CLI template is missing or stale for this code environment; rebuild the CLI template'
    );
  }
  return variant.snapshotId;
}

/** One keyed read on new allocation only. Existing sessions keep their own filesystem. */
export async function resolveNativeCliTemplate(
  userId: string,
  provider: SandboxProvider,
  size: SandboxSize,
  baseTemplateId: string,
  read = readUserCodeTemplate
): Promise<string> {
  const head = await read(userId);
  return head === null || head.revision === 0
    ? baseTemplateId
    : selectNativeCliTemplate(head.variants, provider, size, baseTemplateId);
}
