import { buildNetworkMatch } from './format';
import * as grepRepo from './grepRepo';
import type { GrepMatch, ValidatedGrepInput } from './types';

/**
 * `network` grep. Mirrors messageSearchService: `filters.path` addresses one
 * contact, and its name segment resolves through the same identifier space as
 * the messages `person` filter (full name, phone, email, or person id).
 */
export async function searchNetworkSource(params: {
  userId: string;
  input: ValidatedGrepInput;
}): Promise<{ total: number; matches: GrepMatch[] }> {
  const { userId, input } = params;
  const contact = input.filters.network?.pathContact;
  let personId: string | undefined;
  if (contact !== undefined) {
    const resolved = await grepRepo.resolvePersonId(userId, contact);
    if (resolved === null) return { total: 0, matches: [] };
    personId = resolved;
  }
  const [total, rows] = await Promise.all([
    grepRepo.countNetworkGrepRows({
      userId,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
      personId,
    }),
    grepRepo.searchNetworkGrepRows({
      userId,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
      limit: input.headLimit,
      offset: input.offset,
      personId,
    }),
  ]);
  return { total, matches: rows.map((row) => buildNetworkMatch(row, input)) };
}
