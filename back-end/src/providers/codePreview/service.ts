/**
 * Owner-scoped preview + publish for one code-agent task (A1 routes).
 *
 *   GET  /:taskId/preview  ─► loadOwnedCodeTask ─► resolveTaskPreview
 *   POST /:taskId/publish  ─► loadOwnedCodeTask ─► session fs ─► publishCodeSessionBranch
 *
 * A foreign task is indistinguishable from an unknown one (null → 404). The
 * dev-account gate (403) runs in the route before anything is read.
 */
import { Sandbox } from 'e2b';
import { prisma } from '../database';
import { isLocalClaudeCodeSandboxId, resolveLocalSessionWorkDir } from '../claudeCodeLocalSession';
import { isLocalDeviceSandboxId } from '../localDevices/hub';
import { e2bSandboxFs, localSandboxFs, type CodeSessionFs } from '../codeSessions/sandboxFs';
import { githubRepoOf, isRoseRepoUrl, type CodePreviewView } from './preview';
import { resolveTaskPreview } from './status';
import { CodePublishError, publishCodeSessionBranch, type CodePublishResult } from './publish';

export { CodePublishError } from './publish';

const codeSessionSelect = {
  id: true,
  userId: true,
  state: true,
  sandboxKind: true,
  sandboxId: true,
  homeDir: true,
  repoUrl: true,
  branch: true,
  mergeTarget: true,
  lastRepoFacts: true,
} as const;

async function loadOwnedCodeTask(userId: string, taskId: string) {
  const task = await prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
    select: { id: true, agentId: true, sandboxId: true, streamUrl: true, codeSessionId: true },
  });
  if (task === null) return null;
  const agent = await prisma.agent.findUnique({
    where: { id: task.agentId },
    select: { userId: true },
  });
  if (agent?.userId !== userId) return null;
  const codeSession =
    task.codeSessionId !== null
      ? await prisma.codeSession.findUnique({
          where: { id: task.codeSessionId },
          select: codeSessionSelect,
        })
      : null;
  return { task, codeSession: codeSession?.userId === userId ? codeSession : null };
}

export async function getOwnedTaskPreview(
  userId: string,
  taskId: string,
  fetchImpl?: typeof fetch
): Promise<CodePreviewView | null> {
  const owned = await loadOwnedCodeTask(userId, taskId);
  if (owned === null) return null;
  return resolveTaskPreview(
    {
      taskId: owned.task.id,
      sandboxId: owned.task.sandboxId,
      streamUrl: owned.task.streamUrl,
      codeSession: owned.codeSession,
    },
    { fetchImpl }
  );
}

/** Sessions scanned for the user's Rose app (newest first; one indexed query). */
const ROSE_SESSION_SCAN_LIMIT = 20;

/**
 * The built-in Rose app's live preview: the user's most recently active
 * Rose-repo code session and its newest task. No probe (the list stays fast);
 * clients read GET /:taskId/preview for status.
 */
export async function findLatestRosePreview(userId: string): Promise<CodePreviewView | null> {
  const sessions = await prisma.codeSession.findMany({
    where: { userId, state: { in: ['ACTIVE', 'PAUSED'] } },
    orderBy: { lastActiveAt: 'desc' },
    take: ROSE_SESSION_SCAN_LIMIT,
    select: { ...codeSessionSelect, ownerAgentId: true },
  });
  const rose = sessions.find((session) => isRoseRepoUrl(session.repoUrl));
  if (rose === undefined) return null;
  const task = await prisma.claudeCodeSession.findFirst({
    where: { agentId: rose.ownerAgentId, codeSessionId: rose.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, sandboxId: true, streamUrl: true },
  });
  if (task === null) return null;
  return resolveTaskPreview(
    { taskId: task.id, sandboxId: task.sandboxId, streamUrl: task.streamUrl, codeSession: rose },
    { probe: false }
  );
}

async function sessionFs(
  task: { id: string; sandboxId: string },
  codeSession: { sandboxKind: string | null; sandboxId: string | null; homeDir: string | null }
): Promise<CodeSessionFs> {
  if (isLocalDeviceSandboxId(task.sandboxId)) {
    throw new CodePublishError(
      409,
      'UNSUPPORTED_TARGET',
      'This code agent runs on your Mac; it pushes and opens the PR from there'
    );
  }
  if (isLocalClaudeCodeSandboxId(task.sandboxId) || codeSession.sandboxKind === 'local') {
    return localSandboxFs(codeSession.homeDir ?? resolveLocalSessionWorkDir(task.id));
  }
  const sandbox = await Sandbox.connect(codeSession.sandboxId ?? task.sandboxId, {
    apiKey: process.env.E2B_API_KEY,
  });
  return e2bSandboxFs(sandbox);
}

export async function publishOwnedTask(
  userId: string,
  taskId: string,
  body: { title?: string; body?: string; draft?: boolean },
  opts: { fetchImpl?: typeof fetch; fs?: CodeSessionFs } = {}
): Promise<CodePublishResult | null> {
  const owned = await loadOwnedCodeTask(userId, taskId);
  if (owned === null) return null;
  if (owned.codeSession === null) {
    throw new CodePublishError(409, 'NO_CODE_SESSION', 'This task has no persistent code session');
  }
  if (owned.codeSession.state === 'RETIRED') {
    throw new CodePublishError(409, 'SESSION_RETIRED', 'This code session was closed for good');
  }
  // Before touching the sandbox: connecting would resume a paused one.
  if (githubRepoOf(owned.codeSession.repoUrl) === null) {
    throw new CodePublishError(409, 'NOT_A_GITHUB_REPO', 'This code session has no GitHub repo');
  }
  const fs = opts.fs ?? (await sessionFs(owned.task, owned.codeSession));
  return publishCodeSessionBranch({
    session: owned.codeSession,
    fs,
    title: body.title,
    body: body.body,
    draft: body.draft,
    fetchImpl: opts.fetchImpl,
  });
}
