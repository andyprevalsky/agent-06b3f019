export interface SupervisorToolTraceEntry {
  sequence: number;
  round: number;
  phase: 'dispatch' | 'commit' | 'completion';
  tool: string;
  arguments: Record<string, unknown>;
  success: boolean;
  result: string;
  resultTruncated: boolean;
  error?: string;
}

/** Preserve call evidence while removing user content from production results. */
export function redactTraceEntry(entry: SupervisorToolTraceEntry): SupervisorToolTraceEntry {
  return {
    ...entry,
    result: `[redacted ${String(entry.result.length)} chars]`,
    ...(entry.error === undefined
      ? {}
      : { error: `[redacted ${String(entry.error.length)} chars]` }),
  };
}
