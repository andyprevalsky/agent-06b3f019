/** Owner-scoped root workspace discovery. Read-only: never wakes or provisions work. */
import { resolveTaskPreview } from '../../providers/codePreview/status';
import { rootPreviewPath } from '../../providers/codePreview/rootPath';
import type { CodePreviewView } from '../../providers/codePreview/preview';
import * as repo from './rootPreviewRepo';

type PreviewRoot = NonNullable<Awaited<ReturnType<typeof repo.ownedPreviewAgent>>>;
const MAX_PARENT_HOPS = 32;

async function resolveRoot(userId: string, agentId: string): Promise<PreviewRoot | null> {
  let agent = await repo.ownedPreviewAgent(userId, agentId);
  if (!agent) return null;
  const expectedRoots = new Set<string>();
  const seen = new Set<string>();
  for (let hops = 0; agent && hops < MAX_PARENT_HOPS; hops++) {
    if (seen.has(agent.id)) return null;
    seen.add(agent.id);
    if (agent.busId !== null && agent.busId !== '') expectedRoots.add(agent.busId);
    if (agent.parentAgentId === null || agent.parentAgentId === '') {
      const root = agent;
      return [...expectedRoots].every((id) => id === root.id) ? root : null;
    }
    agent = await repo.ownedPreviewAgent(userId, agent.parentAgentId);
  }
  return null;
}

export interface RootPreviewView {
  agent_id: string;
  root_agent_id: string;
  stable_path: string;
  code_session_id: string | null;
  task_id: string | null;
  status: CodePreviewView['status'] | 'unavailable';
  preview_url: string | null;
  checked_at: string;
}

async function previewAnswers(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2500),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

export async function getRootPreview(
  userId: string,
  agentId: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<RootPreviewView | null> {
  const root = await resolveRoot(userId, agentId);
  if (!root) return null;
  const base: RootPreviewView = {
    agent_id: agentId,
    root_agent_id: root.id,
    stable_path: rootPreviewPath(root.id),
    code_session_id: null,
    task_id: null,
    status: 'unavailable',
    preview_url: null,
    checked_at: new Date().toISOString(),
  };
  const repoUrl =
    root.githubRepoUrl ?? (root.project?.userId === userId ? root.project.repoUrl : null);
  const session = await repo.primaryRootPreviewSession(userId, root.id, repoUrl);
  if (!session) return base;
  base.code_session_id = session.id;
  if (session.state === 'PAUSED') return { ...base, status: 'paused' };
  // A backend-host or device loopback URL is not a public staging address.
  if (session.sandboxId === null || session.sandboxId === '' || session.sandboxKind !== 'e2b')
    return base;
  const task = await repo.latestRootPreviewTask(root.id, session.id);
  if (!task) return base;
  const preview = await resolveTaskPreview(
    {
      taskId: task.id,
      sandboxId: session.sandboxId,
      streamUrl: task.streamUrl,
      codeSession: session,
    },
    { probe: false }
  );
  return {
    ...base,
    task_id: task.id,
    status:
      preview.preview_url !== null &&
      preview.preview_url !== '' &&
      (await previewAnswers(preview.preview_url, options.fetchImpl ?? fetch))
        ? 'running'
        : 'not_running',
    preview_url: preview.preview_url,
    checked_at: preview.checked_at,
  };
}
