/** Resolve the backend API origin for browser and test environments. */
export function resolveBackendBaseUrl(
  explicitUrl: string | undefined = import.meta.env.VITE_BACKEND_API_URL,
  locationLike: Pick<Location, 'protocol' | 'hostname' | 'port'> | undefined = typeof window ===
  'undefined'
    ? undefined
    : window.location,
  allowDynamicLocalInference = !import.meta.env.VITEST,
  electronRenderer = typeof window !== 'undefined' &&
    (window as typeof window & { api?: unknown }).api !== undefined,
): string {
  const explicit = explicitUrl ? explicitUrl.replace(/\/$/, '') : '';
  if (electronRenderer) return explicit || 'http://localhost:3001';

  if (import.meta.env.DEV && allowDynamicLocalInference && locationLike) {
    const frontendPort = Number(locationLike.port);
    const isLocalHost =
      locationLike.hostname === 'localhost' || locationLike.hostname === '127.0.0.1';
    const explicitIsDefaultLocal =
      explicit === 'http://localhost:3001' || explicit === 'http://127.0.0.1:3001';
    const explicitIsLocal =
      explicit.startsWith('http://localhost:') || explicit.startsWith('http://127.0.0.1:');
    if (!isLocalHost && explicitIsLocal) {
      return '';
    }
    if (isLocalHost && Number.isInteger(frontendPort) && frontendPort > 1) {
      if (!explicit || (explicitIsDefaultLocal && frontendPort !== 3002)) {
        return `${locationLike.protocol}//${locationLike.hostname}:${frontendPort - 1}`;
      }
    }
  }

  if (explicit) return explicit;

  return 'http://localhost:3001';
}

export const BACKEND_BASE_URL = resolveBackendBaseUrl();

export function backendApiUrl(): string {
  return BACKEND_BASE_URL.endsWith('/api') ? BACKEND_BASE_URL : `${BACKEND_BASE_URL}/api`;
}
