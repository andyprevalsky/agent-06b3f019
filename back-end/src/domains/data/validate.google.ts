/**
 * `calendar` and `drive` grep filter parsing. Split from validate.filters.ts
 * for max-lines compliance.
 */

import { InvalidGrepParamError } from './errors';
import { parseGrepPath } from './path';
import {
  isGoogleGrepSource,
  type GoogleGrepSource,
  type GoogleSourceGrepFilters,
  type GrepParams,
  type ValidSource,
} from './types';
import {
  parseFilterDate,
  parseFilterSince,
  parseFilterString,
  rejectUnsupportedFilters,
  requireFilterObject,
} from './validate.filters';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function dateOnly(filters: Record<string, unknown>, key: string): string | undefined {
  const value = filters[key];
  return typeof value === 'string' && DATE_ONLY.test(value.trim()) ? value.trim() : undefined;
}

/** A printed `calendar/...` or `drive/...` path, for a source that is selected. */
function pathFilter(
  rawPath: string | undefined,
  sources: ValidSource[]
): Pick<GoogleSourceGrepFilters, 'pathSource' | 'pathPrefix'> {
  if (rawPath === undefined) return {};
  const parsed = parseGrepPath(rawPath);
  if (parsed === null || (parsed.source !== 'calendar' && parsed.source !== 'drive')) {
    throw new InvalidGrepParamError('filters.path');
  }
  if (!sources.includes(parsed.source)) throw new InvalidGrepParamError('filters.path');
  return {
    pathSource: parsed.source,
    ...(parsed.rest === undefined ? {} : { pathPrefix: parsed.rest }),
  };
}

export function parseGoogleSourceFilters(
  params: GrepParams,
  sources: ValidSource[]
): GoogleSourceGrepFilters | undefined {
  const raw = requireFilterObject(params);
  if (Object.keys(raw).length === 0) return undefined;
  for (const source of sources.filter(isGoogleGrepSource)) rejectUnsupportedFilters(source, raw);
  const sinceDate = dateOnly(raw, 'since');
  const untilDate = dateOnly(raw, 'until');
  const until = parseFilterDate(raw, 'until');
  return {
    since: parseFilterSince(raw, 'since'),
    // A date-only `until` means through the end of that day.
    until:
      until !== undefined && untilDate !== undefined
        ? new Date(until.getTime() + DAY_MS - 1)
        : until,
    ...(sinceDate === undefined ? {} : { sinceDate }),
    ...(untilDate === undefined ? {} : { untilDate }),
    ...pathFilter(parseFilterString(raw, 'path'), sources),
  };
}

/** The Google source a printed path belongs to, when it is one. */
export function googleSourceOfPath(path: unknown): GoogleGrepSource | undefined {
  if (typeof path !== 'string') return undefined;
  if (path === 'calendar' || path.startsWith('calendar/')) return 'calendar';
  if (path === 'drive' || path.startsWith('drive/')) return 'drive';
  return undefined;
}
