/**
 * Normalize text by converting escape sequences to their actual characters.
 * Handles cases where the LLM or backend sends escaped characters as string literals.
 */
export function normalizeMarkdownText(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\*/g, '*')
    .replace(/\\_/g, '_')
    .replace(/\\`/g, '`')
    .replace(/\\#/g, '#')
    .replace(/\\\[/g, '[')
    .replace(/\\\]/g, ']')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')');
}
