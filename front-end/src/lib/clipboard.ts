/**
 * Canonical clipboard wrapper around navigator.clipboard.
 * Domain code must import from here instead of calling navigator.clipboard directly —
 * enforced via `no-restricted-syntax`.
 */

export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
