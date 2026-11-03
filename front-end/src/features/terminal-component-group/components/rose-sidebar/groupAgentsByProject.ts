/**
 * Pure grouping for the Rose Desktop left bar (UI ledger row 57): one group per
 * project in the order the Projects API returns them, with Rose first, plus the
 * Home (root project) agents. The bar renders the projects above Home. An agent
 * whose `project_id` is missing, null or not a known project belongs to Home.
 */

import type { Project } from '@/lib/api/projects';
import type { Agent } from '../../hooks';

export interface ProjectAgentGroup {
  project: Project;
  agents: Agent[];
}

export interface GroupedAgents {
  home: Agent[];
  projects: ProjectAgentGroup[];
}

export function groupAgentsByProject(agents: Agent[], projects: Project[]): GroupedAgents {
  const byProject = new Map<string, Agent[]>(projects.map((p) => [p.id, []]));
  const home: Agent[] = [];
  for (const agent of agents) {
    const bucket =
      agent.project_id !== undefined && agent.project_id !== null
        ? byProject.get(agent.project_id)
        : undefined;
    if (bucket === undefined) home.push(agent);
    else bucket.push(agent);
  }
  return {
    home,
    projects: [...projects]
      .sort(
        (a, b) => Number(b.name.toLowerCase() === 'rose') - Number(a.name.toLowerCase() === 'rose'),
      )
      .map((project) => ({ project, agents: byProject.get(project.id) ?? [] })),
  };
}
