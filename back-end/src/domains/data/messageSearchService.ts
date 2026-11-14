import { resolveMessageAccess, messageOwnership } from './teamAccessRepo';
import { buildMessageConversationMatch } from './format.messages';
import * as grepRepo from './grepRepo';
import { findMessageContextRows, searchConversationMatchRows } from './messageContextRepo';
import {
  DATA_SOURCE_CONFIGS,
  type GrepMatch,
  type ValidSource,
  type ValidatedGrepInput,
} from './types';

export async function searchMessageSource(params: {
  userId: string;
  input: ValidatedGrepInput;
  source: ValidSource;
}): Promise<{ total: number; matches: GrepMatch[] }> {
  const { userId, input, source } = params;
  const access = await resolveMessageAccess(userId, input.teamScope);
  let personIds: string[] | undefined;
  const messageFilters = input.filters.messages;
  // `filters.path` addresses a thread; its thread segment is the same identifier
  // space `person` already resolves (full name, phone, email, or person id), so
  // an emitted path narrows through the existing, tested resolution.
  const personIdentifier = messageFilters?.person ?? messageFilters?.pathThread;
  if (personIdentifier !== undefined) {
    const resolved = await grepRepo.resolveMessagePersonIds(access, personIdentifier);
    if (resolved.length === 0) return { total: 0, matches: [] };
    personIds = resolved;
  }
  const channel =
    source === 'messages' ? undefined : (DATA_SOURCE_CONFIGS[source].channel ?? undefined);
  const [total, rows] = await Promise.all([
    grepRepo.countMessageGrepRows({
      userId,
      access,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
      personIds,
      messageId: messageFilters?.pathMessageId,
      since: messageFilters?.since,
      channel,
    }),
    searchConversationMatchRows({
      userId,
      access,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
      limit: input.headLimit,
      offset: input.offset,
      personIds,
      messageId: messageFilters?.pathMessageId,
      since: messageFilters?.since,
      channel,
    }),
  ]);
  const contextRows = await findMessageContextRows({
    userId,
    access,
    anchorIds: rows.map((row) => row.id),
    before: input.contextBefore,
    after: input.contextAfter,
    since: messageFilters?.since,
    channel,
  });
  const contextByAnchor = new Map<string, typeof contextRows>();
  for (const row of contextRows) {
    const current = contextByAnchor.get(row.anchorId) ?? [];
    current.push(row);
    contextByAnchor.set(row.anchorId, current);
  }
  return {
    total,
    matches: rows.map((row) => ({
      ...buildMessageConversationMatch(row, contextByAnchor.get(row.id) ?? [], input),
      ownership: messageOwnership(access, row),
    })),
  };
}
