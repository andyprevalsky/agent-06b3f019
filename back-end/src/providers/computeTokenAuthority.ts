/** The one configured authority for internal compute-token operations. */
export function computeTokenAuthority(): { url: string; apiKey: string } | null {
  const url = (process.env.COMPUTE_TOKEN_AUTHORITY_URL ?? '').trim();
  if (url === '') return null;
  const apiKey = (process.env.COMPUTE_TOKEN_AUTHORITY_API_KEY ?? '').trim();
  if (apiKey === '')
    throw new Error('COMPUTE_TOKEN_AUTHORITY_URL requires COMPUTE_TOKEN_AUTHORITY_API_KEY');
  return { url: url.replace(/\/+$/, ''), apiKey };
}
