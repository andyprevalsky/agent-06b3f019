/**
 * Overlay local Claude/Codex ws-server into E2B sandboxes so template drift
 * does not block code-agent benches.
 */
import { Sandbox } from 'e2b';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { createLogger } from './logger';
import { CODEX_AZURE_MODEL_CATALOG_FILE } from './codexTemplate';

const log = createLogger('E2bWsOverlay');

const CLAUDE_CODE_WS_SERVER_PATH = '/home/user/ws-server.mjs';
/** Where ws-server.mjs looks for the Azure catalog: its own directory. */
export const CODEX_AZURE_MODEL_CATALOG_SANDBOX_PATH = `/home/user/${CODEX_AZURE_MODEL_CATALOG_FILE}`;

export function findLocalClaudeCodeWsServer(): string | null {
  const candidates = [
    join(process.cwd(), '..', 'e2b-templates', 'claude-code', 'ws-server.mjs'),
    join(process.cwd(), 'e2b-templates', 'claude-code', 'ws-server.mjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function findLocalCodexCodeWsServer(): string | null {
  // The template ID names a remote E2B image. The local source directory is
  // fixed, including when the default ID is used or an image ID is overridden.
  const candidates = [
    join(process.cwd(), '..', 'e2b-templates', 'codex-code', 'ws-server.mjs'),
    join(process.cwd(), 'e2b-templates', 'codex-code', 'ws-server.mjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * The shipped Azure Codex model catalog when it describes `deployment`, else
 * null (the CLI's bundled catalog then applies).
 */
export function codexAzureModelCatalogFor(deployment: string): Buffer | null {
  const serverPath = findLocalCodexCodeWsServer();
  if (serverPath === null) return null;
  const catalogPath = join(dirname(serverPath), CODEX_AZURE_MODEL_CATALOG_FILE);
  if (!existsSync(catalogPath)) return null;
  const content = readFileSync(catalogPath);
  const models = (JSON.parse(content.toString('utf8')) as { models?: { slug?: string }[] }).models;
  return (models ?? []).some((model) => model.slug === deployment) ? content : null;
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
  // The funded Azure provider's model catalog travels with the ws-server that reads it.
  const catalogPath = join(dirname(serverPath), CODEX_AZURE_MODEL_CATALOG_FILE);
  if (existsSync(catalogPath)) {
    await sandbox.files.write(
      CODEX_AZURE_MODEL_CATALOG_SANDBOX_PATH,
      new Blob([readFileSync(catalogPath)])
    );
  }
  await sandbox.commands.run(
    `chmod +x ${CLAUDE_CODE_WS_SERVER_PATH} && chown 1000:1000 ${CLAUDE_CODE_WS_SERVER_PATH}`,
    { timeoutMs: 10000 }
  );
  log.info(`Overlayed Codex Code ws-server from ${serverPath}`);
}
