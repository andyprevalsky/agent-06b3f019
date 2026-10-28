/**
 * wait_for titles are composed as "Waiting for <description>", and models often
 * write the description as a full phrase ("Waiting for Chase balances"), which
 * read "Waiting for Waiting for Chase balances". These keep exactly one prefix.
 */
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

/**
 * The work-row label of a wait_for row. Waits on listed agents name them by task
 * name ("Waiting for pull_bank_data"), as the agents panel does, even when the
 * model's description differs; otherwise the title with one "Waiting for" prefix.
 */
export function waitForRowLabel(
  metadata: Record<string, unknown> | undefined,
  title: string,
): string {
  if (!WAIT_PREFIX.test(title) || metadata?.waitForMode !== 'agents') return waitingTitle(title);
  const names = Array.isArray(metadata.targetNames)
    ? metadata.targetNames.map(declaredName)
    : Array.isArray(metadata.agents)
      ? metadata.agents.map(taskName)
      : [];
  return names.length > 0 && names.every(Boolean)
    ? `Waiting for ${names.join(', ')}`
    : waitingTitle(title);
}
