/**
 * Overlay local Claude/Codex ws-server into E2B sandboxes so template drift
 * does not block code-agent benches.
 */
import { Sandbox } from 'e2b';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from './logger';

const log = createLogger('E2bWsOverlay');

const CLAUDE_CODE_WS_SERVER_PATH = '/home/user/ws-server.mjs';

export function findLocalClaudeCodeWsServer(): string | null {
  const candidates = [
    join(process.cwd(), '..', 'e2b-templates', 'claude-code', 'ws-server.mjs'),
    join(process.cwd(), 'e2b-templates', 'claude-code', 'ws-server.mjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function findLocalCodexCodeWsServer(): string | null {
  // Directory name matches the E2B template id (set via env; no hardcoded secret).
  const templateDir = process.env.E2B_CODEX_CODE_TEMPLATE_ID?.trim();
  if (!templateDir) return null;
  const candidates = [
    join(process.cwd(), '..', 'e2b-templates', templateDir, 'ws-server.mjs'),
    join(process.cwd(), 'e2b-templates', templateDir, 'ws-server.mjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function fileHash(path: string | null): string {
  if (path === null || !existsSync(path)) return 'bundled';
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

export async function overlayClaudeCodeWsServer(
  sandbox: Awaited<ReturnType<typeof Sandbox.create>>
): Promise<void> {
  const serverPath = findLocalClaudeCodeWsServer();
  if (serverPath === null) {
    log.warn('Claude Code ws-server overlay not found; using server bundled in E2B template');
    return;
  }

  const content = readFileSync(serverPath);
  await sandbox.files.write(CLAUDE_CODE_WS_SERVER_PATH, new Blob([content]));
  await sandbox.commands.run(
    `chmod +x ${CLAUDE_CODE_WS_SERVER_PATH} && chown 1000:1000 ${CLAUDE_CODE_WS_SERVER_PATH}`,
    { timeoutMs: 10000 }
  );
  log.info(`Overlayed Claude Code ws-server from ${serverPath}`);
}

export async function overlayCodexCodeWsServer(
  sandbox: Awaited<ReturnType<typeof Sandbox.create>>
): Promise<void> {
  const serverPath = findLocalCodexCodeWsServer();
  if (serverPath === null) {
    log.warn('Codex Code ws-server overlay not found; using server bundled in E2B template');
    return;
  }

  const content = readFileSync(serverPath);
  await sandbox.files.write(CLAUDE_CODE_WS_SERVER_PATH, new Blob([content]));
  await sandbox.commands.run(
    `chmod +x ${CLAUDE_CODE_WS_SERVER_PATH} && chown 1000:1000 ${CLAUDE_CODE_WS_SERVER_PATH}`,
    { timeoutMs: 10000 }
  );
  log.info(`Overlayed Codex Code ws-server from ${serverPath}`);
}
