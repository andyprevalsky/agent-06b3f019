/**
 * Chat router project context (RCA 2026-11-06 root-agent-project-context).
 *
 *   handleChatMessage ──┬─ messages ─────────────────────────┐
 *                       └─ loadRouterProjectContext(agentId) ┴─> callRouterLlm / callGeneratorLlm
 *                            one PK read per turn (Agent ⋈ Project)   markCacheable(prompt, project)
 *
 * The section rides after the static Router/Generator prompts' cache boundary,
 * so each static prefix stays byte-identical and a Home chat is unchanged.
 * 10k agents: one indexed PK read per chat turn, no shared row or channel.
 */
import { prisma } from '../database';
import { parseGithubUrl } from '../github';
import { createLogger } from '../logger';

const log = createLogger('ProjectContext');

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

/**
 * Optional prompt enrichment: a failed lookup reads as "no project" (a Home chat)
 * so the turn that awaits it alongside its messages still runs.
 */
export async function loadRouterProjectContext(agentId: string): Promise<string> {
  try {
    const row = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { project: { select: { name: true, repoUrl: true, defaultBranch: true } } },
    });
    return renderRouterProjectContext(row?.project ?? null);
  } catch (error) {
    log.warn('Project lookup failed; continuing without it', {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}
