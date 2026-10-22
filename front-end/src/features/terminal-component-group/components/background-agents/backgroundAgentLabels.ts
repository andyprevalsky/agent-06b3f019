/** Pure text helpers for the running-agents dock. */

/** Collapse whitespace; ellipsis is left to CSS so the full text stays in `title`. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
