import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sandbox } from 'e2b';
import { createLogger } from './logger';

const log = createLogger('E2BCodexHarness');
const CODEX_ROSE_BRIDGE_PATH = '/home/user/rose-bridge.mjs';

function findLocalCodexRoseBridge(): string | null {
  const candidates = [
    join(process.cwd(), '..', 'e2b-templates', 'codex-code', 'rose-bridge.mjs'),
    join(process.cwd(), 'e2b-templates', 'codex-code', 'rose-bridge.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function overlayCodexRoseBridge(
  sandbox: Awaited<ReturnType<typeof Sandbox.create>>
): Promise<void> {
  const bridgePath = findLocalCodexRoseBridge();
  if (bridgePath === null) {
    log.warn('Codex rose-bridge overlay not found; harness API calls may fail');
    return;
  }
  const content = readFileSync(bridgePath);
  await sandbox.files.write(CODEX_ROSE_BRIDGE_PATH, new Blob([content]));
  await sandbox.commands.run(`chmod +x ${CODEX_ROSE_BRIDGE_PATH}`, { timeoutMs: 10000 });
  log.info(`Overlayed Codex rose-bridge from ${bridgePath}`);
}
