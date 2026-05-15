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

export function detectActionFromPartialJson(json: string): string | null {
  const match = json.match(/"action"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

export function formatWebSearchStreamTitle(query: string): string {
  const displayQuery = query.length > 80 ? `${query.slice(0, 77)}...` : query;
  return `🔍 Searching the web for ${displayQuery}`;
}
