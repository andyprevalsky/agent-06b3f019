/** Stable app entry point: deriving it never allocates a sandbox, build or worker. */
export function rootPreviewPath(rootAgentId: string): string {
  return `/?agent-id=${encodeURIComponent(rootAgentId)}&browser=local`;
}
