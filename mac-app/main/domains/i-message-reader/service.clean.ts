/**
 * i-message-reader — service sub-layer: row cleaning + text sanitation
 *
 * Pure logic for turning a RawMessageRow (plus a contact map) into an
 * enriched IMessageData. All text-extraction heuristics live here — the main
 * service.ts orchestrates the DB + contact reads and calls into these helpers.
 *
 * Layer rule: service files may import own repo, own types, own config.
 * This file only imports config + types (plus external bplist-parser).
 */

import * as bplistParserModule from 'bplist-parser';
import {
  ATTRIBUTED_BODY_SEARCH_MAX_DEPTH,
  INVALID_HANDLE_SENTINEL,
  SHORT_CODE_MAX_LENGTH,
} from './config';
import { lookupContact } from './repo';
import type {
  ContactRecord,
  IMessageData,
  MessageCandidateSource,
  MessageColumnPresence,
  RawMessageRow,
} from './types';

// ── bplist-parser binding ─────────────────────────────────────────────────

const bplistParser = bplistParserModule as unknown as {
  parseBuffer: (buffer: Buffer) => unknown[];
};

// ── text cleaners ─────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- intentional control-char strip for iMessage binary payloads
const CONTROL_CHAR_NULL_REGEX = /\u0000/g;
// eslint-disable-next-line no-control-regex -- intentional control-char strip for iMessage binary payloads
const CONTROL_CHAR_RANGE_REGEX = /[\x00-\x1F\x7F]/g;

function stripControlCharacters(value: string): string {
  return value
    .replace(CONTROL_CHAR_NULL_REGEX, '')
    .replace(/\uFFFC/g, '')
    .replace(CONTROL_CHAR_RANGE_REGEX, '')
    .replace(/\uFFFD/g, '')
    .trim();
}

function stripLeadingMarkers(value: string): string {
  if (value.length < 3) return value;
  const first = value[0];
  const second = value[1];
  if (/^[A-Za-z0-9'#:%!]/.test(first)) {
    if (second === second.toUpperCase() || second === ' ' || /^['"\d#:%!]/.test(first)) {
      const withoutFirst = value.substring(1);
      if (withoutFirst.length > 0 && /^[A-Z]/.test(withoutFirst[0])) {
        return withoutFirst;
      }
    }
  }
  return value;
}

function applyAttributedSplitHeuristic(value: string): string {
  let result = value;
  const startDelimiter = 'NSString��+';
  const endDelimiter = '��';
  if (!value.includes(startDelimiter)) return value;
  result = value.split(startDelimiter)[1];
  result = result.substring(1);
  // Remove all leading '�' characters until a non-'�' character is seen.
  let firstNonReplacementChar = 0;
  while (result[firstNonReplacementChar] === '�') {
    firstNonReplacementChar++;
  }
  if (firstNonReplacementChar > 0) {
    result = result.substring(firstNonReplacementChar);
  }
  result = result.split(endDelimiter)[0];

  result = stripControlCharacters(result);
  result = stripLeadingMarkers(result);
  return result.trim();
}

function sanitizeMessageCandidate(
  candidate: unknown,
  messageId: number,
  source: MessageCandidateSource = 'text'
): string | null {
  if (candidate === null || candidate === undefined) return null;
  let value = candidate;

  if (typeof value === 'object') {
    try {
      value = JSON.stringify(value);
    } catch (error) {
      console.warn(`[IMessageReader] Failed to stringify message ${messageId} candidate`, error);
      return null;
    }
  }

  const rawString = value === null || value === undefined ? '' : String(value);
  let normalized = stripControlCharacters(rawString);
  if (normalized === '') return null;

  normalized = stripLeadingMarkers(normalized);

  if (source === 'attributed') {
    normalized = applyAttributedSplitHeuristic(rawString);
  }

  return normalized;
}

// ── attributedBody plist decoding ─────────────────────────────────────────

function searchValue(value: unknown, depth: number): string | null {
  if (value === null || value === undefined || depth > ATTRIBUTED_BODY_SEARCH_MAX_DEPTH) {
    return null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return stripLeadingMarkers(stripControlCharacters(value));
  }

  if (typeof value === 'object' && value !== null) {
    const rec = value as { NS?: { string?: unknown } };
    if (rec.NS !== undefined && typeof rec.NS.string === 'string') {
      return stripLeadingMarkers(stripControlCharacters(rec.NS.string));
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const result = searchValue(item, depth + 1);
      if (result !== null) return result;
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const val of Object.values(value)) {
      const result = searchValue(val, depth + 1);
      if (result !== null) return result;
    }
  }

  return null;
}

function extractTextFromAttributedBody(buffer: Buffer | null | undefined): string | null {
  if (buffer === null || buffer === undefined || buffer.length === 0) return null;
  const tryPlainString = (): string | null => {
    const asString = buffer.toString('utf8').replace(/\0/g, '').trim();
    return asString === '' ? null : asString;
  };

  const header = buffer.slice(0, 6).toString('utf8');
  if (header !== 'bplist') {
    return tryPlainString();
  }

  try {
    const parsed = bplistParser.parseBuffer(buffer);
    if (parsed.length === 0) return tryPlainString();
    const archive = parsed[0] as { $objects?: unknown } | undefined;
    const objects = Array.isArray(archive?.$objects) ? archive.$objects : [];
    const candidates: string[] = [];

    for (const obj of objects) {
      if (typeof obj === 'string') {
        if (
          obj.startsWith('NS') ||
          obj.startsWith('__kIM') ||
          obj.startsWith('CF$') ||
          obj.includes('NSAttributedString') ||
          obj === 'NSObject' ||
          obj === 'NSDictionary'
        ) {
          continue;
        }
        candidates.push(obj);
      } else if (obj !== null && typeof obj === 'object') {
        const asRecord = obj as { NSString?: unknown; NS?: { string?: unknown } };
        if (typeof asRecord.NSString === 'string') {
          candidates.push(asRecord.NSString);
        }
        if (asRecord.NS !== undefined && typeof asRecord.NS.string === 'string') {
          candidates.push(asRecord.NS.string);
        }
      }
    }

    const cleanedCandidates = candidates
      .map((candidate) => stripLeadingMarkers(stripControlCharacters(candidate)))
      .filter((candidate) => candidate !== '');

    if (cleanedCandidates.length > 0) {
      cleanedCandidates.sort((a, b) => b.length - a.length);
      return cleanedCandidates[0];
    }

    return searchValue(archive, 0) ?? tryPlainString();
  } catch (error) {
    console.warn('[IMessageReader] Failed to decode attributedBody:', error);
    return tryPlainString();
  }
}

// ── handle helpers ────────────────────────────────────────────────────────

export function normalizeHandle(handle: string): string {
  if (handle === '') return INVALID_HANDLE_SENTINEL;
  const trimmed = handle.trim();
  if (trimmed === '') return INVALID_HANDLE_SENTINEL;
  return trimmed.includes('@') ? trimmed.toLowerCase() : trimmed;
}

// ── row → IMessageData projection ─────────────────────────────────────────

export interface CleanRowOptions {
  columns: MessageColumnPresence;
  contactMap: Map<string, ContactRecord>;
  onSkipMissingHandle?: () => void;
  onSkipShortCode?: () => void;
  onSkipEmptyText?: () => void;
}

function resolveCleanedText(row: RawMessageRow, columns: MessageColumnPresence): string | null {
  let cleanedText = sanitizeMessageCandidate(row.text, row.id);

  const needsFallback = (value: string | null): boolean => value === null || value.trim() === '';

  if (
    needsFallback(cleanedText) &&
    columns.hasAssociatedTextColumn &&
    row.associated_message_text !== null
  ) {
    cleanedText = sanitizeMessageCandidate(row.associated_message_text, row.id, 'associated');
  }

  if (
    needsFallback(cleanedText) &&
    columns.hasAttributedBodyColumn &&
    row.attributedBody !== null
  ) {
    const decoded = extractTextFromAttributedBody(row.attributedBody);
    cleanedText = sanitizeMessageCandidate(decoded, row.id, 'attributed');
  }

  return cleanedText;
}

function resolveContactName(
  row: RawMessageRow,
  contactId: string,
  contactInfo: ContactRecord | undefined
): string {
  let contactName =
    row.contact_name !== null && row.contact_name !== '' ? row.contact_name : contactId;
  if (contactInfo !== undefined) {
    const fullName = [contactInfo.firstName, contactInfo.lastName]
      .filter((part): part is string => part !== undefined && part !== null && part !== '')
      .join(' ')
      .trim();
    if (fullName !== '') {
      contactName = fullName;
    }
  }
  return contactName;
}

function nullableString(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return value;
}

export function cleanRow(row: RawMessageRow, options: CleanRowOptions): IMessageData | null {
  const { columns, contactMap, onSkipMissingHandle, onSkipShortCode, onSkipEmptyText } = options;

  const rawHandle = row.handle_id ?? row.chat_identifier ?? '';
  const contactId = normalizeHandle(rawHandle);
  if (contactId === INVALID_HANDLE_SENTINEL) {
    onSkipMissingHandle?.();
    return null;
  }

  if (/^\d+$/.test(contactId) && contactId.length <= SHORT_CODE_MAX_LENGTH) {
    onSkipShortCode?.();
    return null;
  }

  const cleanedText = resolveCleanedText(row, columns);
  if (cleanedText === null || cleanedText === '') {
    onSkipEmptyText?.();
    return null;
  }

  const contactInfo = lookupContact(contactId, contactMap);
  const contactName = resolveContactName(row, contactId, contactInfo);

  return {
    id: row.id,
    text: cleanedText,
    date: row.date,
    is_from_me: row.is_from_me === 1,
    contact_id: contactId,
    contact_name: contactName,
    contact_firstName: nullableString(contactInfo?.firstName),
    contact_lastName: nullableString(contactInfo?.lastName),
    contact_email: nullableString(contactInfo?.emails?.[0]),
    contact_company: nullableString(contactInfo?.company),
    contact_title: nullableString(contactInfo?.jobTitle),
    contact_emailAddresses: contactInfo?.emails ?? [],
  };
}
