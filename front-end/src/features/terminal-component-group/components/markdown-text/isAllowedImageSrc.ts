/**
 * Chat markdown may embed photos from arbitrary HTTPS CDNs (Maps, venues).
 * Allow http(s), same-origin paths, and blob: object URLs. Reject javascript:,
 * data:, file:, and protocol-relative hosts so untrusted text cannot run script
 * or force a tracking pixel via a non-http scheme.
 */
export function isAllowedImageSrc(src: string | undefined | null): src is string {
  if (!src) return false;
  const trimmed = src.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('//')) return false;
  if (trimmed.startsWith('/')) return true;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'blob:';
  } catch {
    return false;
  }
}
