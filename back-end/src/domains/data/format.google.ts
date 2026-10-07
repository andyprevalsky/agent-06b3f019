/**
 * Render Google Calendar and Drive rows as grep matches. Pure presentation.
 *
 * Two shapes, as with grep itself:
 *  - across many records, one match per record that leads with the record's
 *    header, so a hit always says what it is, when, and where to open it;
 *  - on the one record a path names, every matching line (all lines when there
 *    is no pattern), in order and paged, which is how a file is read.
 */

import { MAX_RESULT_CHARS } from './config';
import { metadataString, valueToLine } from './format.snippets';
import type { GoogleSourceGrepRow } from './googleSourceRepo';
import { buildGoogleSourcePath } from './path';
import type { GoogleGrepSource, GrepMatch, ValidatedGrepInput } from './types';

/** Body lines shown with the header when a record is one of many. */
const PREVIEW_BODY_LINES: Record<GoogleGrepSource, number> = { calendar: 7, drive: 0 };

/** A default page of matches (20) read from one file stays within one result's budget. */
const READ_PAGE_CHARS = Math.floor(MAX_RESULT_CHARS / 20);

interface RecordLines {
  header: string[];
  body: string[];
}

function present(lines: Array<string | null>): string[] {
  return lines.filter((line): line is string => line !== null);
}

function calendarLines(row: GoogleSourceGrepRow): RecordLines {
  return {
    header: present([valueToLine('title', row.title), valueToLine('url', row.url)]),
    body: row.content === '' ? [] : row.content.split('\n'),
  };
}

function driveLines(row: GoogleSourceGrepRow): RecordLines {
  const indexed = (row.metadata as { contentIndexed?: unknown } | null)?.contentIndexed === true;
  const body = indexed ? row.content.split('\n') : [];
  return {
    header: present([
      valueToLine('title', row.title),
      valueToLine('type', metadataString(row.metadata, 'mimeType')),
      valueToLine('modified', metadataString(row.metadata, 'modifiedTime')),
      valueToLine('owner', metadataString(row.metadata, 'owner')),
      valueToLine('url', row.url),
      indexed ? `text: ${body.length} lines` : 'text: not loaded',
    ]),
    body,
  };
}

function recordLines(row: GoogleSourceGrepRow, source: GoogleGrepSource): RecordLines {
  return source === 'calendar' ? calendarLines(row) : driveLines(row);
}

function matchTimestamp(row: GoogleSourceGrepRow, source: GoogleGrepSource): Date {
  const start = source === 'calendar' ? metadataString(row.metadata, 'start') : undefined;
  const parsed = start === undefined ? undefined : new Date(start);
  if (parsed !== undefined && !Number.isNaN(parsed.getTime())) return parsed;
  return row.sourceUpdatedAt ?? row.updatedAt;
}

/**
 * The pointer carries Google's own id for the event or file. The row's
 * database id is never shown: printed beside a Google Docs title it reads as a
 * document id, and an agent built a docs.google.com link from it.
 */
function matchIdentity(
  row: GoogleSourceGrepRow,
  source: GoogleGrepSource
): Omit<GrepMatch, 'content'> {
  const path = buildGoogleSourcePath(
    source,
    metadataString(row.metadata, 'path') ?? row.externalId
  );
  const googleId = metadataString(row.metadata, source === 'calendar' ? 'eventId' : 'fileId');
  return {
    source,
    path,
    pointer: `${source}:${googleId ?? row.id}`,
    timestamp: matchTimestamp(row, source).toISOString(),
    location: { source, path, field: 'content' },
  };
}

/** Indexes of the lines the pattern matches; every line when there is no pattern. */
function matchingLines(lines: string[], input: ValidatedGrepInput): number[] {
  if (input.pattern === '') return lines.map((_, index) => index);
  const probe = new RegExp(input.regex.source, input.regex.flags.replace('g', ''));
  const hits = lines.flatMap((line, index) => (probe.test(line) ? [index] : []));
  if (hits.length > 0) return hits;
  // A pattern that spans lines matches no single line; fall back to its span.
  const whole = probe.exec(lines.join('\n'));
  if (whole === null) return [];
  const text = lines.join('\n');
  const first = text.slice(0, whole.index).split('\n').length - 1;
  const last = text.slice(0, whole.index + whole[0].length).split('\n').length - 1;
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

/** Matched lines widened by the requested context, as sorted unique indexes. */
function withContext(hits: number[], total: number, input: ValidatedGrepInput): number[] {
  const wanted = new Set<number>();
  for (const hit of hits) {
    const from = Math.max(0, hit - input.contextBefore);
    const to = Math.min(total - 1, hit + input.contextAfter);
    for (let index = from; index <= to; index += 1) wanted.add(index);
  }
  return [...wanted].sort((a, b) => a - b);
}

function numbered(lines: string[], index: number, input: ValidatedGrepInput): string {
  return input.showLineNumbers ? `${index + 1}: ${lines[index]}` : lines[index];
}

export function buildGoogleSourceMatch(
  row: GoogleSourceGrepRow,
  source: GoogleGrepSource,
  input: ValidatedGrepInput
): GrepMatch {
  const { header, body } = recordLines(row, source);
  const lines = [...header, ...body];
  const preview = Math.min(lines.length, header.length + PREVIEW_BODY_LINES[source]);
  const shown = new Set(Array.from({ length: preview }, (_, index) => index));
  if (input.pattern !== '') {
    const [first] = matchingLines(lines, input);
    if (first !== undefined) {
      for (const index of withContext([first], lines.length, input)) shown.add(index);
    }
  }
  const content = [...shown]
    .sort((a, b) => a - b)
    .map((index) => numbered(lines, index, input))
    .join('\n');
  return { ...matchIdentity(row, source), content };
}

/**
 * The one event or file a path names, as consecutive matches: its matching
 * lines in order (all of them with no pattern), so `head_limit` and `offset`
 * page through it like any other result. A line longer than a page continues
 * on the next one under the same line number.
 */
export function buildGoogleSourcePages(
  row: GoogleSourceGrepRow,
  source: GoogleGrepSource,
  input: ValidatedGrepInput
): GrepMatch[] {
  const { header, body } = recordLines(row, source);
  const lines = [...header, ...body];
  const hits = matchingLines(lines, input);
  if (hits.length === 0) return [buildGoogleSourceMatch(row, source, input)];

  const pages: string[] = [];
  let page: string[] = [];
  let size = 0;
  let previous = -2;
  const flush = (): void => {
    if (page.length === 0) return;
    pages.push(page.join('\n'));
    page = [];
    size = 0;
  };
  for (const index of withContext(hits, lines.length, input)) {
    // A gap between matched regions starts a new match, like grep's hunks.
    if (index !== previous + 1) flush();
    previous = index;
    const label = input.showLineNumbers ? `${index + 1}: ` : '';
    const line = lines[index];
    for (let at = 0; at === 0 || at < line.length; at += READ_PAGE_CHARS) {
      const piece = `${label}${line.slice(at, at + READ_PAGE_CHARS)}`;
      if (size + piece.length > READ_PAGE_CHARS) flush();
      page.push(piece);
      size += piece.length + 1;
    }
  }
  flush();
  const identity = matchIdentity(row, source);
  return pages.map((content) => ({ ...identity, content }));
}
