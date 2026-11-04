/**
 * The grep filter contract in one place.
 *
 * `filters` takes either flat keys or one block per source:
 *
 *   {since: '7d', path: 'messages/Ann.thread'}           flat
 *   {calendar: {since: '2026-11-02'}, messages: {...}}   nested (key = source name)
 *
 * The two never collide: no filter key is a source name. A flat key, like the
 * top-level shorthands `person`, `since` and `until`, applies to every
 * selected source that accepts it, and is rejected only when none does. A
 * nested block applies to its own source (`messages` also covers the channel
 * sources email, gmail, imessage and whatsapp) and must use that source's
 * keys. Null values and empty objects mean "not given". Each source's keys
 * come from DATA_SOURCE_CONFIGS, the same list the GrepTool schema documents.
 */

import { InvalidGrepParamError } from './errors';
import {
  DATA_SOURCE_CONFIGS,
  MESSAGE_FAMILY_SOURCES,
  VALID_SOURCES,
  isGoogleGrepSource,
  isMessageFamilySource,
  type GrepParams,
  type ValidSource,
} from './types';

type FilterObject = Record<string, unknown>;

export interface SplitFilters {
  flat: FilterObject;
  nested: Partial<Record<ValidSource, FilterObject>>;
}

/** Top-level shorthands that broadcast like flat filter keys. */
const BROADCAST_PARAMS = ['person', 'since', 'until'] as const;

export function isSourceName(key: string): key is ValidSource {
  return key in VALID_SOURCES;
}

function acceptedKeys(source: ValidSource): readonly string[] {
  return DATA_SOURCE_CONFIGS[source].filters;
}

function acceptedBy(key: string): string {
  const sources = (Object.keys(VALID_SOURCES) as ValidSource[]).filter((source) =>
    acceptedKeys(source).includes(key)
  );
  return sources.length === 0 ? 'no source' : sources.join(', ');
}

function dropNulls(value: FilterObject): FilterObject {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null));
}

/** Null-valued top-level params are absent, as the tool schema marks them optional. */
export function dropNullParams(params: GrepParams): GrepParams {
  return dropNulls(params as FilterObject) as GrepParams;
}

function requireObject(value: unknown, param: string): FilterObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidGrepParamError(
      param,
      'filters must be an object of filter keys, or of per-source blocks such as {"calendar": {"since": "2026-11-02"}}.'
    );
  }
  return dropNulls(value as FilterObject);
}

export function splitFilters(params: GrepParams): SplitFilters {
  if (params.filters === undefined || params.filters === null) return { flat: {}, nested: {} };
  const flat: FilterObject = {};
  const nested: SplitFilters['nested'] = {};
  for (const [key, value] of Object.entries(requireObject(params.filters, 'filters'))) {
    if (!isSourceName(key)) {
      flat[key] = value;
      continue;
    }
    const block = requireObject(value, `filters.${key}`);
    if (Object.keys(block).length > 0) nested[key] = block;
  }
  return { flat, nested };
}

export function hasFilters(split: SplitFilters): boolean {
  return Object.keys(split.flat).length > 0 || Object.keys(split.nested).length > 0;
}

/** The nested block that addresses `source`, if any. */
function nestedBlockFor(split: SplitFilters, source: ValidSource): [string, FilterObject] | [] {
  const own = split.nested[source];
  if (own !== undefined) return [source, own];
  const umbrella = split.nested.messages;
  if (isMessageFamilySource(source) && umbrella !== undefined) return ['messages', umbrella];
  return [];
}

function validateNestedKeys(split: SplitFilters, sources: ValidSource[]): void {
  for (const [key, block] of Object.entries(split.nested) as [ValidSource, FilterObject][]) {
    const covers = sources.filter(
      (source) => source === key || (key === 'messages' && isMessageFamilySource(source))
    );
    if (covers.length === 0) {
      throw new InvalidGrepParamError(
        `filters.${key}`,
        `It is a block for the ${key} source, which is not in sources (${sources.join(', ')}). ` +
          `Add ${key} to sources or nest the filters under a selected source.`
      );
    }
    for (const filterKey of Object.keys(block)) {
      if (!acceptedKeys(key).includes(filterKey)) {
        throw new InvalidGrepParamError(
          `filters.${key}.${filterKey}`,
          `${key} accepts ${acceptedKeys(key).join(', ')}.`
        );
      }
    }
  }
}

function setOnce(target: FilterObject, key: string, value: unknown, param: string): void {
  if (key in target && JSON.stringify(target[key]) !== JSON.stringify(value)) {
    throw new InvalidGrepParamError(
      param,
      `${key} is given twice with different values; give it once.`
    );
  }
  target[key] = value;
}

/** Flat and top-level keys no selected source accepts are caller errors. */
function rejectUnplacedKeys(params: GrepParams, split: SplitFilters, sources: ValidSource[]): void {
  const placed = (key: string) => sources.some((source) => acceptedKeys(source).includes(key));
  const accepts = sources.map((source) => `${source} accepts ${acceptedKeys(source).join(', ')}`);
  const unplaced = (key: string) =>
    `${accepts.join('; ')}. ${key} applies to ${acceptedBy(key)}; select one of those sources or remove it.`;
  for (const key of Object.keys(split.flat)) {
    if (placed(key)) continue;
    const hint =
      key === 'trace_path'
        ? 'Move it to the top-level trace_path parameter; inside filters the agent path key is path.'
        : unplaced(key);
    throw new InvalidGrepParamError(`filters.${key}`, hint);
  }
  for (const key of BROADCAST_PARAMS) {
    if (params[key] !== undefined && !placed(key)) {
      throw new InvalidGrepParamError(key, unplaced(key));
    }
  }
}

/**
 * Effective filter object for each selected source: flat keys it accepts, its
 * nested block, then the top-level shorthands it accepts.
 */
export function filtersBySource(
  params: GrepParams,
  split: SplitFilters,
  sources: ValidSource[]
): Map<ValidSource, FilterObject> {
  validateNestedKeys(split, sources);
  rejectUnplacedKeys(params, split, sources);
  const bySource = new Map<ValidSource, FilterObject>();
  for (const source of sources) {
    const keys = acceptedKeys(source);
    const effective: FilterObject = {};
    for (const [key, value] of Object.entries(split.flat)) {
      if (keys.includes(key)) effective[key] = value;
    }
    const [blockKey, block] = nestedBlockFor(split, source);
    for (const [key, value] of Object.entries(block ?? {})) {
      setOnce(effective, key, value, `filters.${blockKey}.${key}`);
    }
    for (const key of BROADCAST_PARAMS) {
      if (params[key] !== undefined && keys.includes(key)) {
        setOnce(effective, key, params[key], key);
      }
    }
    bySource.set(source, effective);
  }
  return bySource;
}

/**
 * Sources that share one parsed filter set (the message channels; calendar and
 * drive) must resolve to the same filters.
 */
export function sharedFilters(
  bySource: Map<ValidSource, FilterObject>,
  group: 'messages' | 'google'
): FilterObject {
  const members = [...bySource.entries()].filter(([source]) =>
    group === 'messages' ? MESSAGE_FAMILY_SOURCES.includes(source) : isGoogleGrepSource(source)
  );
  const first = members[0]?.[1] ?? {};
  for (const [source, filters] of members) {
    if (JSON.stringify(filters) !== JSON.stringify(first)) {
      throw new InvalidGrepParamError(
        `filters.${source}`,
        `${members.map(([name]) => name).join(' and ')} are searched together and take one filter set; ` +
          'give the same filters to each or search them separately.'
      );
    }
  }
  return first;
}

/** Sources a caller named only through its filters: nested blocks, or a printed path. */
export function sourcesNamedByFilters(split: SplitFilters): ValidSource[] {
  const named = Object.keys(split.nested) as ValidSource[];
  const path = split.flat.path;
  if (typeof path === 'string') {
    const root = path.split('/', 1)[0];
    if (isSourceName(root) && !named.includes(root)) named.push(root);
  }
  return named;
}
