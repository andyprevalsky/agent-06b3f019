/**
 * Human-readable titles for explore-agent steps.
 *
 * The worker streams generic tool titles ("Searching the web"); these rewrite
 * them with the actual query/URL so a step list reads as a narrative. Split out
 * of deduplicateToolMessages.ts to keep that module inside the file-size budget.
 */

import type { Message } from '../api';
import type { ExploreStep } from '../types';
import { extractLineValue, extractMarkdownParam } from './messageTextParsing';

function formatWebSearchTitle(
  rawTitle: string,
  status: ExploreStep['status'],
  query: string | undefined,
): string {
  if (!query) return rawTitle;
  if (
    rawTitle !== 'Searching the web' &&
    rawTitle !== 'Web search completed' &&
    rawTitle !== '❌ Web search failed'
  ) {
    return rawTitle;
  }

  if (status === 'ERROR') return `Web search failed for ${query}`;
  if (status === 'FINISHED') return `Searched the web for ${query}`;
  return `Searching the web for ${query}`;
}

function formatWebFetchTitle(
  rawTitle: string,
  status: ExploreStep['status'],
  text: string,
): string {
  if (
    rawTitle !== 'Fetching web content' &&
    rawTitle !== 'Web fetch complete' &&
    rawTitle !== '❌ Web fetch failed'
  ) {
    return rawTitle;
  }

  const activeMatch = text.match(/^Extracting from\s+([^:]+):\s*(.+)$/im);
  const url = activeMatch?.[1]?.trim() || extractMarkdownParam(text, 'url');
  const objective = activeMatch?.[2]?.trim() || extractMarkdownParam(text, 'objective');
  if (!url && !objective) return rawTitle;

  const target = [url, objective ? `for ${objective}` : ''].filter(Boolean).join(' ');
  if (status === 'ERROR') return `Web fetch failed for ${target}`;
  if (status === 'FINISHED') return `Fetched ${target}`;
  return `Fetching ${target}`;
}

/** Title for one explore step, specialized for web_search / web_fetch tools. */
export function deriveExploreStepTitle(m: Message, status: ExploreStep['status']): string {
  const rawTitle = ((m.metadata?.title as string) || '').trim();
  const text = m.text || '';
  const toolName = (m.metadata?.toolName as string) || '';

  if (toolName === 'web_search') {
    const query =
      typeof m.metadata?.query === 'string'
        ? m.metadata.query
        : extractLineValue(text, 'Query') || extractMarkdownParam(text, 'query');
    return formatWebSearchTitle(rawTitle, status, query);
  }

  if (toolName === 'web_fetch') {
    return formatWebFetchTitle(rawTitle, status, text);
  }

  return rawTitle;
}
