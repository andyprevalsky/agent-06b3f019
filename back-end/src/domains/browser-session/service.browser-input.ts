export function isValidBrowserKeySymbols(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 16 &&
    value.every((key: unknown) => typeof key === 'string' && key.length > 0 && key.length <= 64)
  );
}

export function validateBrowserKeySymbols(keys: string[]): void {
  if (!isValidBrowserKeySymbols(keys)) {
    throw new Error(
      'keys must contain between 1 and 16 non-empty key symbols of at most 64 characters'
    );
  }
}
