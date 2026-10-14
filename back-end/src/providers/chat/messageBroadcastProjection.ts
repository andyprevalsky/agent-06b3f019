/** Reference-driven fan-out trees hydrate child outputs from the tree API/bus. */
export function projectMessageBroadcastMetadata(
  role: string,
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (
    role !== 'TOOL' ||
    metadata?.toolName !== 'spawn_general_purpose_agent_for_each' ||
    metadata.forEachAggregate !== true ||
    (metadata.toolStatus !== 'FINISHED' && metadata.toolStatus !== 'ERROR') ||
    typeof metadata.busId !== 'string' ||
    metadata.busId.trim().length === 0 ||
    !Array.isArray(metadata.subAgentIds) ||
    metadata.subAgentIds.length === 0 ||
    !metadata.subAgentIds.every((id) => typeof id === 'string' && id.trim().length > 0)
  ) {
    return metadata;
  }
  const projected = { ...metadata };
  delete projected.structured_response;
  return projected;
}
