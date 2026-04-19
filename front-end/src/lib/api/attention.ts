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

// Check and respond to pending attention request for agent
export async function checkAndRespondToAttentionRequest(
  agentId: string,
  response: string,
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
      body: JSON.stringify({ response }),
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
): Promise<void> {
  const headers = getAuthHeaders();

  const res = await fetch(`${API_BASE_WITH_PATH}/attention-requests/${requestId}/respond`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ response: responseText }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to respond to attention request');
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
