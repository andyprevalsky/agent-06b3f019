import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

// =============================================================================
// Signup Workflow Signals (for request_user_signup tool)
// =============================================================================

/**
 * Signal the agent workflow that signup was completed
 */
export async function signalSignupCompleted(agentId: string): Promise<void> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}/signal/signup_completed`, {
    method: 'POST',
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to signal signup completed');
  }
}

/**
 * Signal the agent workflow that signup was dismissed (continue as anonymous)
 */
export async function signalSignupDismissed(agentId: string): Promise<void> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}/signal/signup_dismissed`, {
    method: 'POST',
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to signal signup dismissed');
  }
}

/**
 * Start agent mode - escalate from chat mode to full Temporal workflow
 */
export async function startAgent(agentId: string): Promise<void> {
  const headers = getAuthHeaders();

  const response = await fetch(`${API_BASE_WITH_PATH}/agents/${agentId}/start-agent`, {
    method: 'POST',
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to start agent');
  }
}
