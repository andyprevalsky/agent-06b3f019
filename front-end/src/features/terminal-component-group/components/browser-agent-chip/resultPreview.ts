/**
 * Plain-text preview of a markdown result for the collapsed chip line:
 * "**Goal**: Log in" → "Goal: Log in". The expanded Result tab still renders
 * the full markdown; this only keeps raw markup out of the two-line preview.
 */
export function markdownPreview(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ');
}
