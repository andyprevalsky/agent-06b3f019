import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

// Attention Requests
export interface AttentionRequest {
  id: string;
  agent_id: string;
  workflow_id: string;
  question: string;
  context?: unknown;
  metadata?: Record<string, unknown> | null;
  user_response?: string | null;
  image_url?: string | null;
  created_at: string;
  updated_at: string;
  answered: boolean;
}

export interface AuthAssistanceHandoff {
  type?: string;
  steelSessionId?: string | null;
  liveViewUrl?: string | null;
}

export interface AuthAssistanceRefreshResponse {
  request?: {
    id: string;
    steelSessionId?: string;
    completedAt?: string | null;
  };
  handoff?: AuthAssistanceHandoff;
  liveViewUrl?: string | null;
  refreshed?: boolean;
  alreadyCompleted?: boolean;
}

// Fetch all pending attention requests for the current user
export async function getAttentionRequests(): Promise<AttentionRequest[]> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/attention-requests`, {
    headers,
  });

  if (!response.ok) {
    throw new Error('Failed to fetch attention requests');
  }

  const data = (await response.json()) as { requests?: AttentionRequest[] };
  return data.requests ?? [];
}

// Check if there's a pending attention request for a specific agent
export async function hasActiveAttentionRequest(agentId: string): Promise<boolean> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/attention-requests`, {
    headers,
  });

  if (!response.ok) {
    return false;
  }

  const data = await response.json();
  const pendingRequest = data.requests?.find(
    (r: AttentionRequest) => r.agent_id === agentId && !r.answered,
  );

  return !!pendingRequest;
}

function attentionResponseBody(response: string, userMessage?: string): string {
  return JSON.stringify({
    response,
    ...(userMessage?.trim() ? { user_message: userMessage } : {}),
  });
}

// Check and respond to pending attention request for agent
export async function checkAndRespondToAttentionRequest(
  agentId: string,
  response: string,
  userMessage?: string,
): Promise<boolean> {
  const headers = getAuthHeaders();

  // Get pending requests
  const requestsResponse = await fetch(`${API_BASE_WITH_PATH}/attention-requests`, {
    headers,
  });

  if (!requestsResponse.ok) {
    return false;
  }

  const data = await requestsResponse.json();
  const pendingRequest = data.requests?.find(
    (r: AttentionRequest) => r.agent_id === agentId && !r.answered,
  );

  if (!pendingRequest) {
    return false;
  }

  // Respond to the request
  const respondResponse = await fetch(
    `${API_BASE_WITH_PATH}/attention-requests/${pendingRequest.id}/respond`,
    {
      method: 'POST',
      headers,
      body: attentionResponseBody(response, userMessage),
    },
  );

  if (!respondResponse.ok) {
    throw new Error('Failed to respond to attention request');
  }

  return true;
}

export async function respondToAttentionRequest(
  requestId: string,
  responseText: string,
  userMessage?: string,
): Promise<void> {
  const headers = getAuthHeaders();

  const res = await fetch(`${API_BASE_WITH_PATH}/attention-requests/${requestId}/respond`, {
    method: 'POST',
    headers,
    body: attentionResponseBody(responseText, userMessage),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to respond to attention request');
  }
}

export async function refreshAuthAssistanceSession(
  requestId: string,
): Promise<AuthAssistanceRefreshResponse> {
  const headers = getAuthHeaders();

  const res = await fetch(`${API_BASE_WITH_PATH}/auth-assistance/${requestId}/refresh-session`, {
    method: 'POST',
    headers,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to refresh auth assistance session');
  }

  return (await res.json()) as AuthAssistanceRefreshResponse;
}

export async function completeAuthAssistanceRequest(requestId: string): Promise<void> {
  const headers = getAuthHeaders();

  const res = await fetch(`${API_BASE_WITH_PATH}/auth-assistance/${requestId}/complete`, {
    method: 'POST',
    headers,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to complete authentication assistance');
  }
}

export async function skipAttentionRequest(requestId: string): Promise<void> {
  const headers = getAuthHeaders();

  const res = await fetch(`${API_BASE_WITH_PATH}/attention-requests/${requestId}/skip`, {
    method: 'POST',
    headers,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to skip attention request');
  }
}

export async function rejectAttentionRequest(requestId: string, message?: string): Promise<void> {
  const headers = getAuthHeaders();

  const res = await fetch(`${API_BASE_WITH_PATH}/attention-requests/${requestId}/reject`, {
    method: 'POST',
    headers,
    body: message ? JSON.stringify({ message }) : undefined,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to reject attention request');
  }
}

export class AuthAssistanceReadError extends Error {
  constructor(public readonly status: number) {
    super('Phone authentication request unavailable');
  }
}

/** Exact authenticated lookup; no provider URL or secret is needed to resolve native attention. */
export async function readAuthAssistanceRequest(
  requestId: string,
  signal: AbortSignal,
): Promise<{ request: unknown }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  const deadline = setTimeout(abort, 15000);
  try {
    const response = await fetch(
      `${API_BASE_WITH_PATH}/auth-assistance/${encodeURIComponent(requestId)}`,
      { headers: getAuthHeaders(), cache: 'no-store', signal: controller.signal },
    );
    if (!response.ok) throw new AuthAssistanceReadError(response.status);
    return (await response.json()) as { request: unknown };
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
  }
}

/** Native completion returns only HTTP classification; never surface arbitrary response bodies. */
export async function submitPhoneAuthCompletion(
  requestId: string,
  signal: AbortSignal,
): Promise<number> {
  const response = await fetch(
    `${API_BASE_WITH_PATH}/auth-assistance/${encodeURIComponent(requestId)}/complete`,
    { method: 'POST', headers: getAuthHeaders(), signal },
  );
  return response.status;
}
