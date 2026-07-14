interface StreamingAttentionVisibilityInput {
  message: string;
}

export function shouldShowStreamingAttention(
  attention: StreamingAttentionVisibilityInput | null,
  subAgentId: string | undefined,
): boolean {
  return attention !== null && attention.message.length > 0 && subAgentId === undefined;
}
