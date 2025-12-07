export type ClientSource = 'WEB' | 'MAC_APP';

export function getClientSource(): ClientSource {
  if (typeof window !== 'undefined' && (window as any)?.api) {
    return 'MAC_APP';
  }
  return 'WEB';
}








