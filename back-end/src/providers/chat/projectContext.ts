/**
 * Chat router project context (RCA 2026-11-06 root-agent-project-context).
 *
 *   handleChatMessage ──┬─ messages ─────────────────────────┐
 *                       └─ loadRouterProjectContext(agentId) ┴─> callRouterLlm
 *                            one PK read (Agent ⋈ Project)         markCacheable(ROUTER prompt, project)
 *
 * The section rides after the static router prompt's cache boundary, so the
 * static prefix stays byte-identical and a Home agent's router call is unchanged.
 * 10k agents: one indexed PK read per chat turn, no shared row or channel.
 */
import { prisma } from '../database';
import { parseGithubUrl } from '../github';

export interface RouterProjectSummary {
  name: string;
  repoUrl: string | null;
  defaultBranch: string;
}

/** `## Project` text for a project chat; '' for a Home chat. */
export function renderRouterProjectContext(project: RouterProjectSummary | null): string {
  const name = project?.name.trim() ?? '';
  if (project === null || name === '') return '';
  const repoUrl = project.repoUrl?.trim() ?? '';
  if (repoUrl === '') {
    return `## Project\nThis chat is in the user's project "${name}", which has no GitHub repo.`;
  }
  const parsed = parseGithubUrl(repoUrl);
  const repo = parsed === null ? repoUrl : `${parsed.owner}/${parsed.repo}`;
  return (
    `## Project\nThis chat is in the user's project "${name}" (GitHub repo ${repo}, default branch ` +
    `${project.defaultBranch}). Agents started from it, including code agents, work inside this repo.`
  );
}

export async function loadRouterProjectContext(agentId: string): Promise<string> {
  const row = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { project: { select: { name: true, repoUrl: true, defaultBranch: true } } },
  });
  return renderRouterProjectContext(row?.project ?? null);
}
