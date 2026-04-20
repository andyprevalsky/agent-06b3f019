/**
 * Network grep service — search the user's contact network by plain-text ILIKE.
 *
 * Used by agents (via grep tool with source="network") to retrieve contacts
 * beyond the top-100 included in system-prompt user context.
 */

import { NETWORK_GREP_LIMIT } from './config';
import type { GrepParams, NetworkGrepResult, NetworkContactMatch } from './types';
import * as repo from './repo';
import { createLogger } from '../../providers/logger';

const log = createLogger('Data');

export class InvalidNetworkPatternError extends Error {
  constructor() {
    super("Required field 'pattern' must be a string. Use '' to list top contacts.");
    this.name = 'InvalidNetworkPatternError';
  }
}

export async function grepNetwork(
  userId: string,
  params: GrepParams
): Promise<NetworkGrepResult> {
  const { pattern } = params;

  if (pattern === undefined || pattern === null || typeof pattern !== 'string') {
    throw new InvalidNetworkPatternError();
  }

  const trimmedPattern = pattern.trim();
  const { total, matches } = await repo.searchContacts({
    userId,
    pattern: trimmedPattern,
    limit: NETWORK_GREP_LIMIT,
  });

  const formatted: NetworkContactMatch[] = matches.map((m) => ({
    person_id: m.id,
    first_name: m.firstName,
    last_name: m.lastName,
    phone_number: m.phoneNumber,
    email: m.email,
    company: m.company,
    title: m.title,
    relation: m.relation,
    communication_frequency: m.communicationFrequency,
    messages_exchanged: m.messagesExchanged,
  }));

  log.info(`grep network: '${trimmedPattern}' -> ${matches.length}/${total} contacts`);

  const truncated = total > matches.length;

  if (matches.length === 0) {
    return {
      matches: [],
      total_matches: 0,
      truncated: false,
      message:
        trimmedPattern === ''
          ? 'No contacts found in your network.'
          : `No contacts matching '${trimmedPattern}'. Try a different keyword (name, company, email domain, phone prefix).`,
    };
  }

  return {
    matches: formatted,
    total_matches: total,
    truncated,
    ...(truncated
      ? {
          message: `Showing top ${matches.length} of ${total} matches by message volume. Narrow the pattern to see more specific contacts.`,
        }
      : {}),
  };
}
