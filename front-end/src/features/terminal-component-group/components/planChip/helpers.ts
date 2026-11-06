import { type PlanTask } from '../../hooks';

export interface TaskWithDeps {
  originalIndex: number;
  text: string;
  toolName: string;
  deps: number[];
}

/**
 * Topologically sort tasks by their dependencies.
 * Tasks with no dependencies come first, then tasks whose deps are satisfied.
 */
export function topologicalSort(
  tasks: PlanTask[],
  deps: Record<string, string[]> | null,
): TaskWithDeps[] {
  const n = tasks.length;
  const normalizedDeps = deps || {};

  const taskInfos: TaskWithDeps[] = tasks.map((task, idx) => ({
    originalIndex: idx,
    // Show the short title; plans made before task titles only have the full goal.
    text: task.title?.trim() || task.goal,
    toolName: task.tool_name,
    deps: (normalizedDeps[String(idx)] || []).map((d) => parseInt(d)),
  }));

  const inDegree = new Map<number, number>();
  const adjList = new Map<number, number[]>();

  for (let i = 0; i < n; i++) {
    inDegree.set(i, 0);
    adjList.set(i, []);
  }

  for (const task of taskInfos) {
    for (const dep of task.deps) {
      if (dep >= 0 && dep < n) {
        adjList.get(dep)!.push(task.originalIndex);
        inDegree.set(task.originalIndex, (inDegree.get(task.originalIndex) || 0) + 1);
      }
    }
  }

  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (inDegree.get(i) === 0) {
      queue.push(i);
    }
  }
  queue.sort((a, b) => a - b);

  const sorted: number[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);

    const neighbors = adjList.get(node) || [];
    const nextLevel: number[] = [];

    for (const neighbor of neighbors) {
      inDegree.set(neighbor, (inDegree.get(neighbor) || 0) - 1);
      if (inDegree.get(neighbor) === 0) {
        nextLevel.push(neighbor);
      }
    }

    nextLevel.sort((a, b) => a - b);
    queue.push(...nextLevel);
  }

  // Cycle - fall back to original order
  if (sorted.length !== n) {
    return taskInfos;
  }

  return sorted.map((idx) => taskInfos[idx]);
}

/** Detect structure type from dependencies */
export function detectStructure(
  tasks: PlanTask[],
  deps: Record<string, string[]> | null,
): 'sequential' | 'parallel' | 'dag' {
  if (!deps || Object.keys(deps).length === 0) {
    return 'parallel';
  }

  const hasDeps = Object.values(deps).some((d) => d.length > 0);
  if (!hasDeps) {
    return 'parallel';
  }

  const n = tasks.length;
  let isChain = true;

  for (let i = 0; i < n; i++) {
    const taskDeps = deps[String(i)] || [];
    if (i === 0) {
      if (taskDeps.length > 0) {
        isChain = false;
        break;
      }
    } else {
      if (taskDeps.length !== 1 || taskDeps[0] !== String(i - 1)) {
        isChain = false;
        break;
      }
    }
  }

  return isChain ? 'sequential' : 'dag';
}

/** Format dependency indices as "→ after 1, 2" notation */
export function formatDeps(deps: number[]): string {
  if (deps.length === 0) return '';

  const sorted = [...deps].sort((a, b) => a - b);
  const displayNums = sorted.map((d) => d + 1);

  return `→ after ${displayNums.join(', ')}`;
}

/**
 * Format tool name for display.
 * e.g., "spawn_browser_agent_v3" → "Browser Agent"
 */
export function formatToolName(toolName: string): string {
  if (!toolName) return '';

  return toolName
    .replace(/^spawn_/, '')
    .replace(/_v\d+$/, '')
    .replace(/_/g, ' ')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** Build header text based on structure and join */
export function buildHeaderText(
  tasks: PlanTask[],
  deps: Record<string, string[]> | null,
  join: 'all' | 'any',
): string {
  const n = tasks.length;
  if (join === 'any') return `${n} Hypotheses`;
  const structure = detectStructure(tasks, deps);
  if (structure === 'sequential') return `${n} Tasks · Sequential`;
  if (structure === 'parallel') return `${n} Tasks · Parallel`;
  return `${n} Tasks`;
}
