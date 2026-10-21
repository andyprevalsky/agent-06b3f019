/** Phone grants and text input are private, stateful operations, including screen reads. */
export function isPhoneHarnessExchange(value: string): boolean {
  try {
    const url = new URL(value);
    const path = url.pathname.toLowerCase();
    if (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      (path === '/api/iphone' || path.startsWith('/api/iphone/'))
    )
      return true;
    const configured = process.env.PHONE_HARNESS_API_URL ?? 'https://api.phone-harness.com';
    return url.protocol === 'https:' && url.origin === new URL(configured).origin;
  } catch {
    return false;
  }
}

export function credentialMetadataUrl(url: string): string {
  const parsed = new URL(url);
  if (isPhoneHarnessExchange(url)) return `${parsed.origin}/phone-harness-private`;
  for (const field of ['search', 'hash', 'username', 'password'] as const) parsed[field] = '';
  return parsed.toString();
}
