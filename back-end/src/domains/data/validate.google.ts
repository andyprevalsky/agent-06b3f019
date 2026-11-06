/**
 * `calendar` and `drive` grep filter parsing. Split from validate.filters.ts
 * for max-lines compliance.
 */

import { InvalidGrepParamError } from './errors';
import { parseGrepPath } from './path';
import { isGoogleGrepSource, type GoogleSourceGrepFilters, type ValidSource } from './types';
import {
  parseFilterDate,
  parseFilterSince,
  parseFilterString,
  printedPathHint,
  type FilterObject,
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
  const google = sources.find(isGoogleGrepSource) ?? 'calendar';
  if (parsed === null || (parsed.source !== 'calendar' && parsed.source !== 'drive')) {
    throw new InvalidGrepParamError('filters.path', printedPathHint(google));
  }
  if (!sources.includes(parsed.source)) {
    throw new InvalidGrepParamError(
      'filters.path',
      `It is a ${parsed.source} path; add ${parsed.source} to sources.`
    );
  }
  return {
    pathSource: parsed.source,
    ...(parsed.rest === undefined ? {} : { pathPrefix: parsed.rest }),
  };
}

export function parseGoogleSourceFilters(
  raw: FilterObject,
  sources: ValidSource[]
): GoogleSourceGrepFilters | undefined {
  if (Object.keys(raw).length === 0) return undefined;
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
