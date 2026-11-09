/** Secondary semantic verifier needs UI context, never codes or account identifiers. */
export function authLossObservation(value: unknown): unknown {
  let remaining = 256;
  const visit = (item: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 8) return '[redacted-bound]';
    if (typeof item === 'string')
      return item
        .slice(0, 32768)
        .split(/(\s+)/)
        .map((word) =>
          word.includes('@')
            ? '[redacted-email]'
            : word
                .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted-token]')
                .replace(/\p{N}+/gu, '[redacted-digits]')
        )
        .join('');
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [key, visit(child, depth + 1)])
      );
    return item; // Numeric native geometry is not OCR content.
  };
  return visit(value, 0);
}
