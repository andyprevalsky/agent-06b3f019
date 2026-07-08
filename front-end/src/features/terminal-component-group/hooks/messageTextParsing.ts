export function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function extractMarkdownParam(text: string, name: string): string | undefined {
  const match = text.match(new RegExp(`^- \\*\\*${name}\\*\\*:\\s*(.+)$`, 'im'));
  return match?.[1] ? stripWrappingQuotes(match[1]) : undefined;
}

export function extractLineValue(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^${label}:\\s*(.+)$`, 'im'));
  return match?.[1] ? stripWrappingQuotes(match[1]) : undefined;
}
