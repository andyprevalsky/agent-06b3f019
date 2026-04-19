export function formatCentsAsDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function parseDollarsToCents(value: string): number | null {
  const cleaned = value.replace(/\$/g, '').trim();
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}
