/**
 * wait_for titles are composed as "Waiting for <description>", and models often
 * write the description as a full phrase ("Waiting for Chase balances"), which
 * read "Waiting for Waiting for Chase balances". These keep exactly one prefix.
 * Waits on agents name each agent by its task title ("Find Update Card").
 */
import { humanizeFieldKey } from './claudeCodeChip.utils';

const WAIT_PREFIX = /^\s*(?:(?:still\s+)?(?:waiting|waited|wait)\s+(?:for|on)\s+)+/i;

/** The waited-on target alone: "Waiting for Chase balances" → "Chase balances". */
export function waitTarget(text: string): string {
  const stripped = text.replace(WAIT_PREFIX, '').trim();
  return stripped || text.trim();
}

/** A "Waiting for …" title with any repeated prefix collapsed to one. */
export function waitingTitle(title: string): string {
  return WAIT_PREFIX.test(title) ? `Waiting for ${waitTarget(title)}` : title;
}

/** Last segment of a task path ("/root/pull_bank_data" → "pull_bank_data"); ids/bare names → null. */
function taskName(address: unknown): string | null {
  if (typeof address !== 'string' || !address.includes('/')) return null;
  return address.split('/').filter(Boolean).at(-1) ?? null;
}

function declaredName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A spawn task name as the agent's title: "find_update_card" → "Find Update Card". */
export function taskTitle(name: string): string {
  return humanizeFieldKey(name);
}

export interface WaitAgentTarget {
  /** Task name (snake_case, the agent's path segment). */
  name: string;
  /** Task title shown to the user. */
  title: string;
  /** Listed address (task path or id), when the row carries one. */
  address: string | null;
  /** Worker-declared kind (metadata.targetTypes): code[:claude|:codex] | browser | explore | general_purpose. */
  type: string | null;
}

/**
 * The agents an agents-mode wait_for row waits on, by task name (worker
 * targetNames, else the listed paths' last segments); null when any target has
 * no name (an agent id, "any").
 */
export function waitAgentTargets(
  metadata: Record<string, unknown> | undefined,
): WaitAgentTarget[] | null {
  if (metadata?.waitForMode !== 'agents') return null;
  const agents = Array.isArray(metadata.agents) ? metadata.agents : [];
  const names = Array.isArray(metadata.targetNames)
    ? metadata.targetNames.map(declaredName)
    : agents.map(taskName);
  if (names.length === 0 || !names.every(Boolean)) return null;
  const types = Array.isArray(metadata.targetTypes) ? metadata.targetTypes : [];
  return names.map((name, index) => ({
    name: name!,
    title: taskTitle(name!),
    address: declaredName(agents[index]),
    type: declaredName(types[index]),
  }));
}

/** "Find Update Card, Pull Bank Data" for a wait's targets. */
export function waitAgentTitles(targets: WaitAgentTarget[]): string {
  return targets.map((target) => target.title).join(', ');
}

/**
 * The work-row label of a wait_for row. Waits on listed agents name them by task
 * title ("Waiting for Pull Bank Data"), as the agents panel names the task, even
 * when the model's description differs; otherwise the title with one "Waiting
 * for" prefix.
 */
export function waitForRowLabel(
  metadata: Record<string, unknown> | undefined,
  title: string,
): string {
  if (!WAIT_PREFIX.test(title)) return waitingTitle(title);
  const targets = waitAgentTargets(metadata);
  return targets ? `Waiting for ${waitAgentTitles(targets)}` : waitingTitle(title);
}
