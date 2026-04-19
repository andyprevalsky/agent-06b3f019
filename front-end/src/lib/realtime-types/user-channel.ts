// =============================================================================
// User Channel Events (user:{userId}) - DEPRECATED
// =============================================================================

/**
 * Event names for the user channel.
 * NOTE: Backend doesn't actively broadcast to this channel.
 * AttentionInbox uses polling instead (10s interval).
 */
export type UserChannelEvent = 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * Attention request structure.
 * Used by AttentionInbox polling, not realtime broadcast.
 */
export interface AttentionRequestPayload {
  id: string;
  agentId: string;
  workflowId: string;
  question: string;
  imageUrl?: string;
  metadata?: Record<string, unknown>;
  userResponse?: string;
  createdAt: string;
  updatedAt: string;
  answered: boolean;
}
