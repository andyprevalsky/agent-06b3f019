/** Optional explicit phone rollout entries. No patterns, prefixes or anonymous grants. */
export function parsePhoneAllowlist(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const phones = value.split(',').map((phone) => phone.trim());
  if (phones.length > 512 || phones.some((phone) => !/^\+[1-9]\d{7,14}$/.test(phone))) {
    throw new Error('CLOUD_IPHONE_ALLOWED_PHONES must contain at most 512 exact E.164 numbers');
  }
  return [...new Set(phones)];
}
