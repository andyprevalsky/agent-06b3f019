import { getAuthHeaders } from '../api';
import { API_BASE_WITH_PATH } from '../config';

/** Asks Rose to add an integration; the backend texts the team (idempotent per request_id). */
export async function requestIntegration(request: string, requestId: string): Promise<void> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/requests`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ request, request_id: requestId }),
  });
  if (response.ok) return;
  const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
  throw new Error(
    typeof payload.error === 'string' ? payload.error : 'Could not send your request',
  );
}
