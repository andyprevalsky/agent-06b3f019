/**
 * Whether a code-agent thought's generation was RECORDABLE, derived from the session's raw
 * folded records alone (creation order, usage samples, tool entries). The benchmark check
 * holds the projection to it: a thought it calls recordable must carry a generation; one it
 * calls unrecordable is reported "not measurable" with the reason, never failed.
 *
 * A thought's call window is the usage sample before it and the usage sample after it. The
 * producer samples usage at each model call's start (message_start) and end (message_delta),
 * so the pair brackets the call that generated the thought. The window is recordable unless:
 *  - there is no sample before it (a call whose first sample was never recorded) or none
 *    after it (the session ended or was interrupted before the call finished);
 *  - the samples belong to different native turns/scopes, do not advance, or the thought's
 *    timestamp lies outside them;
 *  - a tool CREATED BEFORE the window finished inside it: that is a tool run across the
 *    window (Codex's per-response samples), not generation. A tool created inside the
 *    window is the call's own: Claude Code runs it as soon as its tool_use block
 *    completes, so it can finish before the call's message_delta.
 * This is written from the specification above, not from the projection's code, so a
 * regression in the projection cannot also hide here.
 */
import type { TranscriptEntry } from '../hooks/codeSessionTranscript';

export type ThoughtWindowVerdict =
  | { recordable: true; fromSeq: number | null; toSeq: number | null; tokens: number }
  | { recordable: false; reason: string };

function isSample(entry: TranscriptEntry): boolean {
  return entry.type === 'metrics' && entry.outputTokens != null && Boolean(entry.usageScope);
}

/** A finished tool run (or a control row), whose completion is an event in the window. */
function isFinishedRun(entry: TranscriptEntry): boolean {
  if (entry.type === 'control') return true;
  return entry.type === 'tool' && (entry.tool?.status === 'ok' || entry.tool?.status === 'error');
}

export function thoughtWindow(
  entries: TranscriptEntry[],
  thoughtKey: string,
): ThoughtWindowVerdict {
  const index = entries.findIndex((entry) => entry.type === 'thinking' && entry.key === thoughtKey);
  if (index < 0)
    return { recordable: false, reason: 'the thinking record is not in the transcript' };
  const thought = entries[index];
  if (thought.partial === true)
    return { recordable: false, reason: 'the thinking record was never finalized' };
  let before: TranscriptEntry | undefined;
  for (let i = index - 1; i >= 0 && !before; i -= 1) if (isSample(entries[i])) before = entries[i];
  const after = entries.slice(index + 1).find(isSample);
  if (!before) return { recordable: false, reason: 'no usage sample precedes it' };
  if (!after)
    return {
      recordable: false,
      reason:
        'no usage sample follows it (the session ended or was interrupted before the call finished)',
    };
  if (before.usageScope !== after.usageScope || before.turnId !== after.turnId)
    return { recordable: false, reason: 'its bracketing usage samples belong to different turns' };
  const from = before.at;
  const to = after.at;
  if (from === null || to === null)
    return { recordable: false, reason: 'a bracketing usage sample has no timestamp' };
  const tokens = (after.outputTokens ?? 0) - (before.outputTokens ?? 0);
  if (tokens <= 0 || to <= from)
    return { recordable: false, reason: 'its bracketing usage samples do not advance' };
  const at = thought.at ?? thought.firstSeenAt;
  if (at === null || at <= from || at > to)
    return { recordable: false, reason: 'its timestamp lies outside its bracketing usage window' };
  const spanning = entries.some((entry) => {
    if (!isFinishedRun(entry) || entry.at === null || entry.at <= from || entry.at > to)
      return false;
    return !(entry.seq !== null && before.seq !== null && entry.seq > before.seq);
  });
  if (spanning)
    return { recordable: false, reason: 'a tool created before the window finished inside it' };
  return { recordable: true, fromSeq: before.seq, toSeq: after.seq, tokens };
}
