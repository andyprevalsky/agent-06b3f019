/** Parse JSON or Streamable HTTP frames without confusing endpoint events with results. */
function parseMcpJsonRpcFrames(bodyText: string): Record<string, unknown>[] {
  const trimmed = bodyText.trim();
  if (trimmed.startsWith('{')) {
    return [JSON.parse(trimmed) as Record<string, unknown>];
  }
  const frames: Record<string, unknown>[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]' || !payload.startsWith('{')) continue;
    try {
      frames.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      // Streamable HTTP may emit a non-JSON endpoint URL as the first data line.
    }
  }
  return frames;
}

function selectMcpJsonRpcFrame(
  frames: Record<string, unknown>[],
  bodyText: string
): Record<string, unknown> {
  const withResult = [...frames].reverse().find((frame) => 'result' in frame);
  if (withResult !== undefined) return withResult;
  const withError = [...frames]
    .reverse()
    .find((frame) => frame.error !== undefined && frame.error !== null);
  if (withError !== undefined) return withError;
  return frames.at(-1) ?? { message: bodyText.trim() };
}

export function parseOrgMcpResponse(bodyText: string): Record<string, unknown> {
  return selectMcpJsonRpcFrame(parseMcpJsonRpcFrames(bodyText), bodyText);
}
