function extractStringField(
  json: string,
  fieldName: string,
  requireClosingQuote: boolean
): string | null {
  const fieldRegex = new RegExp(`"${fieldName}"\\s*:\\s*"`);
  const match = json.match(fieldRegex);
  if (!match || match.index === undefined) return null;

  let result = '';
  let i = match.index + match[0].length;
  while (i < json.length) {
    const char = json[i];
    if (char === '\\' && i + 1 < json.length) {
      result += decodeEscapedJsonChar(json[i + 1]);
      i += 2;
      continue;
    }
    if (char === '"') return result;
    result += char;
    i++;
  }

  return requireClosingQuote ? null : result || null;
}

function decodeEscapedJsonChar(char: string): string {
  switch (char) {
    case '"':
      return '"';
    case '\\':
      return '\\';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    default:
      return char;
  }
}

export function extractPartialStringField(json: string, fieldName: string): string | null {
  return extractStringField(json, fieldName, false);
}

export function extractCompleteStringField(json: string, fieldName: string): string | null {
  return extractStringField(json, fieldName, true);
}

interface ScannedJsonString {
  value: string;
  nextIndex: number;
}

function scanCompleteJsonString(json: string, startIndex: number): ScannedJsonString | null {
  if (json[startIndex] !== '"') return null;
  let escaped = false;
  for (let index = startIndex + 1; index < json.length; index++) {
    const char = json[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char !== '"') continue;
    try {
      return {
        value: JSON.parse(json.slice(startIndex, index + 1)) as string,
        nextIndex: index + 1,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** A complete `["…", …]` array of strings starting at `startIndex`. */
function scanCompleteJsonStringArray(
  json: string,
  startIndex: number
): { value: string[]; nextIndex: number } | null {
  if (json[startIndex] !== '[') return null;
  const value: string[] = [];
  let index = startIndex + 1;
  const skipWhitespace = (): void => {
    while (/\s/.test(json[index] ?? '')) index++;
  };
  skipWhitespace();
  if (json[index] === ']') return { value, nextIndex: index + 1 };
  while (index < json.length) {
    const item = scanCompleteJsonString(json, index);
    if (!item) return null;
    value.push(item.value);
    index = item.nextIndex;
    skipWhitespace();
    if (json[index] === ']') return { value, nextIndex: index + 1 };
    if (json[index] !== ',') return null;
    index++;
    skipWhitespace();
  }
  return null;
}

/**
 * Read only complete top-level string and string-array fields from an
 * in-progress JSON object. Values embedded inside another string can never
 * masquerade as route fields.
 */
export function extractCompleteTopLevelFields(
  json: string
): Record<string, string | string[]> | null {
  const fields: Record<string, string | string[]> = {};
  let index = 0;
  const skipWhitespace = (): void => {
    while (/\s/.test(json[index] ?? '')) index++;
  };

  skipWhitespace();
  if (json[index] !== '{') return null;
  index++;

  while (index < json.length) {
    skipWhitespace();
    if (json[index] === '}') return fields;
    if (json[index] === ',') {
      index++;
      skipWhitespace();
    }

    const key = scanCompleteJsonString(json, index);
    if (!key) return fields;
    index = key.nextIndex;
    skipWhitespace();
    if (json[index] !== ':') return null;
    index++;
    skipWhitespace();

    const value = scanCompleteJsonString(json, index) ?? scanCompleteJsonStringArray(json, index);
    if (!value) return fields;
    fields[key.value] = value.value;
    index = value.nextIndex;
    skipWhitespace();
    if (index < json.length && json[index] !== ',' && json[index] !== '}') return null;
  }

  return fields;
}

export function detectActionFromPartialJson(json: string): string | null {
  const match = json.match(/"action"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

export type ClosedRouterAction =
  'direct_answer' | 'web_search' | 'grep' | 'start_superintelligence';

const CLOSED_ROUTER_ACTIONS = new Set<ClosedRouterAction>([
  'direct_answer',
  'web_search',
  'grep',
  'start_superintelligence',
]);

export function createClosedRouterActionDetector(
  onDetected?: (action: ClosedRouterAction) => void
): (json: string) => void {
  let detected = false;
  return (json: string): void => {
    const action = detectActionFromPartialJson(json);
    if (detected || !action || !CLOSED_ROUTER_ACTIONS.has(action as ClosedRouterAction)) return;
    detected = true;
    onDetected?.(action as ClosedRouterAction);
  };
}

export function formatWebSearchStreamTitle(query: string): string {
  const displayQuery = query.length > 80 ? `${query.slice(0, 77)}...` : query;
  return `🔍 Searching the web for ${displayQuery}`;
}

/** The first complete query, from `queries` or a legacy cached `query`. */
function extractFirstCompleteQuery(json: string): string | null {
  const queries = /"queries"\s*:\s*\[\s*/.exec(json);
  if (queries) {
    return scanCompleteJsonString(json, queries.index + queries[0].length)?.value ?? null;
  }
  return extractCompleteStringField(json, 'query');
}

export function getWebSearchStreamTitleFromPartialRouterJson(json: string): string | null {
  if (detectActionFromPartialJson(json) !== 'web_search') return null;
  const query = extractFirstCompleteQuery(json)?.trim();
  return query ? formatWebSearchStreamTitle(query) : null;
}
