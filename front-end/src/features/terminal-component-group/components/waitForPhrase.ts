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
