/** User-data selectors shared by chat routing and the existing grep executor. */
import { z } from 'zod';

const source = z.enum([
  'messages',
  'email',
  'gmail',
  'imessage',
  'whatsapp',
  'network',
  'agent_network',
  'agent_trajectories',
  'transactions',
  'documents',
  'calendar',
  'drive',
  'summary',
]);
const text = z.string().nullish();
const number = z.number().nullish();
const flag = z.boolean().nullish();

export const ChatGrepParamsSchema = z
  .object({
    pattern: text.describe(
      'Regex over record text; omit for metadata-only agent, calendar or drive queries.'
    ),
    sources: z
      .array(source)
      .nullish()
      .describe(
        'Exact sources to search. Omitted defaults to messages, network and the current agent tree. summary returns the connected-data inventory.'
      ),
    source: source.nullish().describe('Single-source alias for sources.'),
    role: z.enum(['USER', 'ASSISTANT', 'TOOL']).nullish(),
    record_kind: z.enum(['message', 'llm_output', 'llm_context', 'all']).nullish(),
    surface: z.enum(['WEB', 'MAC_APP', 'SMS', 'WHATSAPP']).nullish(),
    trace_path: text,
    order: z.enum(['newest_first', 'oldest_first']).nullish(),
    page_after: text,
    until: text,
    '-A': number,
    '-B': number,
    '-C': number,
    context: number,
    '-n': flag,
    '-i': flag,
    head_limit: number,
    offset: number,
    multiline: flag,
    person: text,
    since: text,
    filters: z
      .object({
        path: text,
        person: text,
        since: text,
        until: text,
        account: text,
        min_amount: number,
        max_amount: number,
        status: z.enum(['posted', 'pending', 'all']).nullish(),
        include_pending_in_totals: flag,
        document_source: z.enum(['chatgpt', 'claude', 'apple_notes', 'obsidian']).nullish(),
        tag: text,
        role: text,
        surface: text,
        record_kind: text,
      })
      .nullish()
      .describe(
        'Source-specific selectors, validated by the data service. Use path to read a prior result; person/since for messages; date/account/amount/status for transactions; document_source/date/path/tag for documents; dates/path for calendar and drive.'
      ),
  })
  .strict();

export type ChatGrepParams = z.infer<typeof ChatGrepParamsSchema>;

/** Structured providers emit unused optional fields as null; the data API takes omissions. */
export function chatGrepParams(params: ChatGrepParams): Record<string, unknown> {
  const result = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== null && value !== undefined)
  );
  if (result.filters && typeof result.filters === 'object') {
    const filters = Object.fromEntries(
      Object.entries(result.filters).filter(([, value]) => value !== null && value !== undefined)
    );
    if (Object.keys(filters).length) result.filters = filters;
    else delete result.filters;
  }
  return result;
}
