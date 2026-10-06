/**
 * Data domain: grep over the `calendar` and `drive` sources.
 *
 * These rows live in the document store but are refreshed from Google right
 * before a search when they are older than the freshness window, so an agent
 * never reads a stale calendar. The refresh never throws; on failure the
 * search runs over the rows already stored.
 */

import {
  GOOGLE_CALENDAR_SOURCE,
  GOOGLE_DRIVE_SOURCE,
} from '../../services/integrations/googleWorkspaceDocuments';
import {
  ON_DEMAND_TEXT_CANDIDATES,
  ensureDriveTextWithin,
  ensureGoogleSourceFreshWithin,
  googleWorkspaceAccountEmails,
  type GoogleSyncOutcome,
} from '../../services/integrations/googleWorkspaceSync';
import { buildGoogleSourceMatch, buildGoogleSourcePages } from './format.google';
import { metadataString } from './format.snippets';
import * as googleRepo from './googleSourceRepo';
import {
  isCalendarOnly,
  type GoogleGrepSource,
  type GoogleSourceGrepFilters,
  type GrepMatch,
  type ValidatedGrepInput,
} from './types';

const DAY_MS = 86_400_000;
/**
 * How long one search waits for a refresh. The agent's grep request times out
 * at 25 seconds, so a longer refresh continues in the background instead.
 */
const REFRESH_WAIT_MS = 8_000;
/** How long one search waits for Drive text it asked for; the rest loads later. */
const DRIVE_TEXT_WAIT_MS = 6_000;

/** What the agent is told when the rows it searched may not be current. */
const STALE_NOTICE: Partial<Record<GoogleSyncOutcome, string>> = {
  in_progress: 'is still syncing from Google, so results may be incomplete. Retry shortly.',
  failed: 'could not be refreshed from Google, so results may be out of date.',
  not_connected:
    'has no Google account that granted access to it. Connecting or reconnecting Google in Rose grants it.',
};

/** With no time or path narrowing, calendar means today and what is upcoming. */
function effectiveFilters(
  source: GoogleGrepSource,
  filters: GoogleSourceGrepFilters | undefined
): GoogleSourceGrepFilters {
  const given = filters ?? {};
  const narrowed =
    given.since !== undefined ||
    given.until !== undefined ||
    given.sinceDate !== undefined ||
    given.untilDate !== undefined ||
    given.pathPrefix !== undefined;
  if (source === 'calendar' && !narrowed) return { since: new Date(Date.now() - DAY_MS) };
  return given;
}

export async function searchGoogleSource(params: {
  userId: string;
  input: ValidatedGrepInput;
  source: GoogleGrepSource;
}): Promise<{ total: number; matches: GrepMatch[]; notice?: string }> {
  const { userId, input, source } = params;
  const given = input.filters.google;
  // A path printed for the other Google source addresses nothing in this one.
  if (given?.pathSource !== undefined && given.pathSource !== source) {
    return { total: 0, matches: [] };
  }
  const documentSource = source === 'calendar' ? GOOGLE_CALENDAR_SOURCE : GOOGLE_DRIVE_SOURCE;
  const outcome = await ensureGoogleSourceFreshWithin(userId, documentSource, REFRESH_WAIT_MS);
  const stale = STALE_NOTICE[outcome];

  const filters = effectiveFilters(source, given);
  if (source === 'drive' && filters.pathPrefix !== undefined) {
    const unread = await googleRepo.findDriveRowsWithoutText(
      userId,
      documentSource,
      filters.pathPrefix,
      ON_DEMAND_TEXT_CANDIDATES
    );
    await ensureDriveTextWithin(userId, unread, DRIVE_TEXT_WAIT_MS);
  }

  const query: googleRepo.GoogleSourceQuery = {
    userId,
    source,
    documentSource,
    pattern: input.dbPattern,
    caseInsensitive: input.caseInsensitive,
    oldestFirst: source === 'calendar' && isCalendarOnly(input.sources),
    filters,
  };
  const [total, rows] = await Promise.all([
    googleRepo.countGoogleSourceRows(query),
    googleRepo.searchGoogleSourceRows(query, input.headLimit + input.offset),
  ]);
  const notice = stale === undefined ? {} : { notice: `${source} ${stale}` };
  // A path that is one event or file: its matching lines, or all of them with
  // no pattern, instead of one summary match.
  const [only] = rows;
  const reading =
    total === 1 &&
    only !== undefined &&
    filters.pathPrefix !== undefined &&
    metadataString(only.metadata, 'path') === filters.pathPrefix;
  if (reading) {
    const pages = buildGoogleSourcePages(only, source, input);
    return {
      total: pages.length,
      matches: pages.slice(0, input.headLimit + input.offset),
      ...notice,
    };
  }
  return {
    total,
    matches: rows.map((row) => buildGoogleSourceMatch(row, source, input)),
    ...notice,
  };
}

/**
 * What the data summary says about Calendar and Drive. Present whenever a
 * Google account that granted them is connected, even before the first refresh
 * has stored anything, because a search is what triggers that refresh.
 */
export async function googleSourceSummary(userId: string): Promise<
  | {
      calendar: { accounts: string[]; total_events: number };
      drive: { accounts: string[]; total_files: number };
    }
  | undefined
> {
  const accounts = await googleWorkspaceAccountEmails(userId);
  if (accounts.length === 0) return undefined;
  const counts = await googleRepo.countGoogleSourceDocuments(userId);
  return {
    calendar: { accounts, total_events: counts[GOOGLE_CALENDAR_SOURCE] ?? 0 },
    drive: { accounts, total_files: counts[GOOGLE_DRIVE_SOURCE] ?? 0 },
  };
}
