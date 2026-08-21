export function validateBrowserKeySymbols(keys: string[]): void {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 16) {
    throw new Error('keys must contain between 1 and 16 key symbols');
  }
  if (keys.some((key) => typeof key !== 'string' || key.length === 0 || key.length > 64)) {
    throw new Error('each key symbol must be a non-empty string of at most 64 characters');
  }
}
