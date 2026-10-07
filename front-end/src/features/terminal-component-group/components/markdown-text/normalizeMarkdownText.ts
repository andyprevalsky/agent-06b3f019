/**
 * Normalize text by converting escape sequences to their actual characters.
 * Handles cases where the LLM or backend sends escaped characters as string literals.
 * Then wrap bare hostnames so both markdown render paths emit real links.
 */
import { linkifyMarkdownText } from './linkifyMarkdownText';

export function normalizeMarkdownText(text: string): string {
  const unescaped = text
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
  return linkifyMarkdownText(unescaped);
}
