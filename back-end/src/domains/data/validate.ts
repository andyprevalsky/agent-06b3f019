/**
 * Data domain grep input validation: param allow-listing, regex compilation +
 * ReDoS safety, and normalization into ValidatedGrepInput.
 */

import { MAX_RESULTS } from './config';
import { InvalidGrepParamError, InvalidPatternError, SourceNotFoundError } from './errors';
import { checkPatternSafety, extractInlineFlags, stripNamedGroups } from './regexSafety';
import { VALID_SOURCES, type GrepParams, type ValidSource, type ValidatedGrepInput } from './types';

const ALLOWED_GREP_KEYS = new Set([
  'pattern',
  'source',
  '-A',
  '-B',
  '-C',
  'context',
  '-n',
  '-i',
  'head_limit',
  'offset',
  'multiline',
  // messages-source-only narrowing.
  'person',
  'since',
  // Internal transport keys, not exposed to the model.
  'agent_id',
  'user_id',
]);

function parseBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return defaultValue;
}

function parseBoundedNumber(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function databaseRegexPattern(pattern: string, multiline: boolean): string {
  if (!multiline) return pattern;
  return pattern.replace(/(?<!\\)\.\*/g, '(.|\n)*').replace(/(?<!\\)\.\+/g, '(.|\n)+');
}

/**
 * Parse the messages-only `since` cutoff. Accepts ISO 8601, or a relative form
 * like `7d` / `24h` / `30m`. Returns undefined for missing/invalid input.
 */
function parseSince(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const relative = value.trim().match(/^(\d+)\s*([dhm])$/i);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const unitMs = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
    return new Date(Date.now() - amount * unitMs);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function validateGrepInput(params: GrepParams): ValidatedGrepInput {
  for (const key of Object.keys(params)) {
    if (!ALLOWED_GREP_KEYS.has(key)) {
      throw new InvalidGrepParamError(key);
    }
  }

  const { pattern, source } = params;
  if (pattern === undefined || pattern === null || typeof pattern !== 'string') {
    throw new InvalidPatternError();
  }
  if (source !== undefined && !(source in VALID_SOURCES)) {
    throw new SourceNotFoundError(source);
  }

  const multiline = parseBoolean(params.multiline, false);
  // Fix 1: fold inline (?i) into case-insensitivity (JS RegExp + Postgres ARE reject it).
  const { pattern: normalizedPattern, caseInsensitive: inlineCaseInsensitive } =
    extractInlineFlags(pattern);
  const caseInsensitive = parseBoolean(params['-i'], false) || inlineCaseInsensitive;
  const flags = `${caseInsensitive ? 'i' : ''}${multiline ? 's' : ''}`;
  let regex: RegExp;
  try {
    regex = new RegExp(normalizedPattern, flags);
  } catch (error) {
    throw new InvalidPatternError(
      `Invalid regular expression '${pattern}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
  // Fix 2: reject ReDoS-catastrophic patterns before they reach Postgres `~`.
  const safety = checkPatternSafety(normalizedPattern, flags);
  if (!safety.ok) {
    throw new InvalidPatternError(safety.reason);
  }

  const symmetricContext = params.context ?? params['-C'];
  const symmetric =
    symmetricContext !== undefined ? parseBoundedNumber(symmetricContext, 0, 0, 25) : undefined;
  const contextBefore =
    symmetric !== undefined ? symmetric : parseBoundedNumber(params['-B'], 0, 0, 25);
  const contextAfter =
    symmetric !== undefined ? symmetric : parseBoundedNumber(params['-A'], 0, 0, 25);

  return {
    pattern,
    // Strip named-capture syntax for Postgres ARE (we only boolean-match).
    dbPattern: databaseRegexPattern(stripNamedGroups(normalizedPattern), multiline),
    sources:
      source !== undefined
        ? [source as ValidSource]
        : (Object.keys(VALID_SOURCES) as ValidSource[]),
    regex,
    caseInsensitive,
    multiline,
    showLineNumbers: parseBoolean(params['-n'], true),
    contextBefore,
    contextAfter,
    headLimit: parseBoundedNumber(params.head_limit, 20, 1, MAX_RESULTS),
    offset: parseBoundedNumber(params.offset, 0, 0, 10_000),
    // messages-source-only narrowing (resolved to a personId in searchSource).
    person:
      typeof params.person === 'string' && params.person.trim() !== ''
        ? params.person.trim()
        : undefined,
    since: parseSince(params.since),
  };
}
