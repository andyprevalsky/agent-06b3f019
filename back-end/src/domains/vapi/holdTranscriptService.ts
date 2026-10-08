/**
 * Pure helpers that stitch a hold-capable call's Vapi segments back into the
 * single call the agent tool expects, and that build a resumed segment's
 * assistant from the conversation so far.
 */
import { HOLD_PRIOR_TRANSCRIPT_CHAR_LIMIT, WAIT_FOR_HUMAN_TOOL_NAME } from './config';
import type { PhoneCallSessionRecord, PhoneHoldPeriod } from './types';

type Json = Record<string, unknown>;

/** Vapi computes analysis shortly after `ended`; wait this long before giving up on it. */
const ANALYSIS_GRACE_MS = 60_000;

export function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function formatHoldDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}

export function holdDurationSeconds(hold: PhoneHoldPeriod, now: Date = new Date()): number {
  const end = hold.endedAt !== undefined ? Date.parse(hold.endedAt) : now.getTime();
  return Math.max(0, (end - Date.parse(hold.startedAt)) / 1000);
}

function describeToolCall(call: unknown): string | null {
  const fn = asObject(asObject(call).function);
  const name = asString(fn.name);
  let args: Json = asObject(fn.arguments);
  if (typeof fn.arguments === 'string') {
    try {
      args = asObject(JSON.parse(fn.arguments));
    } catch {
      args = {};
    }
  }
  if (name === 'dtmf') return `You pressed keypad keys ${asString(args.keys)}.`;
  if (name === WAIT_FOR_HUMAN_TOOL_NAME) return 'You went on hold.';
  if (name === '' || name === 'endCall') return null;
  return `You used ${name}.`;
}

/** One segment as "Callee:" / "You:" lines from Vapi's OpenAI-format artifact. */
export function segmentConversationLines(call: Json): string[] {
  const formatted = asArray(asObject(call.artifact).messagesOpenAIFormatted);
  if (formatted.length === 0) {
    return asString(call.transcript)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => line.replace(/^AI:/, 'You:').replace(/^User:/, 'Callee:'));
  }
  const lines: string[] = [];
  for (const raw of formatted) {
    const message = asObject(raw);
    const content = asString(message.content).trim();
    if (message.role === 'user' && content !== '') lines.push(`Callee: ${content}`);
    if (message.role !== 'assistant') continue;
    if (content !== '') lines.push(`You: ${content}`);
    for (const toolCall of asArray(message.tool_calls)) {
      const described = describeToolCall(toolCall);
      if (described !== null) lines.push(described);
    }
  }
  return lines;
}

export function holdMarker(hold: PhoneHoldPeriod, now: Date = new Date()): string {
  const heard = hold.utterances.find((utterance) => !utterance.liveHuman)?.text ?? hold.heard ?? '';
  const playedNote = heard !== '' ? `; the line played: "${heard.slice(0, 200)}"` : '';
  return `[On hold for ${formatHoldDuration(holdDurationSeconds(hold, now))}${playedNote}]`;
}

/** Conversation across segments with hold markers, oldest first, bounded from the front. */
export function renderPriorConversation(calls: Json[], holds: PhoneHoldPeriod[]): string {
  const parts: string[] = [];
  calls.forEach((call, index) => {
    parts.push(...segmentConversationLines(call));
    const hold = holds[index];
    if (hold !== undefined) parts.push(holdMarker(hold));
  });
  // Vapi renders analysis prompts as Liquid templates; prior text must stay literal.
  const text = parts.join('\n').replace(/\{\{|\}\}|\{%|%\}/g, '');
  return text.length > HOLD_PRIOR_TRANSCRIPT_CHAR_LIMIT
    ? `…${text.slice(-HOLD_PRIOR_TRANSCRIPT_CHAR_LIMIT)}`
    : text;
}

export function buildResumeNote(priorConversation: string, hold: PhoneHoldPeriod): string {
  return [
    'This call is already under way. What happened so far (oldest first):',
    priorConversation === '' ? '(nothing before the hold)' : priorConversation,
    '',
    `You were on hold for ${formatHoldDuration(holdDurationSeconds(hold))} and have just been reconnected because a live person picked up. Their words are the next user message. Answer them directly now and continue toward the call goal. If you are put on hold again, use ${WAIT_FOR_HUMAN_TOOL_NAME} again.`,
  ].join('\n');
}

function withPriorTranscript(analysisPlan: Json, priorConversation: string): Json {
  const transcriptMessage = {
    role: 'user',
    content: `Here is the transcript:\n\n${priorConversation}\n\n{{transcript}}\n\n. Here is the ended reason of the call:\n\n{{endedReason}}\n\n`,
  };
  return {
    ...analysisPlan,
    summaryPlan: {
      ...asObject(analysisPlan.summaryPlan),
      messages: [
        {
          role: 'system',
          content:
            'You are an expert note-taker. You will be given a transcript of a call. Summarize the call in 2-3 sentences. DO NOT return anything except the summary.',
        },
        transcriptMessage,
      ],
    },
    structuredDataPlan: {
      ...asObject(analysisPlan.structuredDataPlan),
      messages: [
        {
          role: 'system',
          content:
            'You are an expert data extractor. You will be given a transcript of a call. Extract structured data per the JSON Schema. DO NOT return anything except the structured data.\n\nJson Schema:\n{{schema}}\n\nOnly respond with the JSON.',
        },
        transcriptMessage,
      ],
    },
  };
}

/** The original assistant, resumed mid-call: it answers the person who picked up. */
export function buildResumedAssistant(
  baseAssistant: Json,
  priorConversation: string,
  hold: PhoneHoldPeriod,
  humanUtterance: string
): Json {
  const model = asObject(baseAssistant.model);
  const systemMessages = asArray(model.messages).filter(
    (message) => asObject(message).role === 'system'
  );
  const assistant: Json = { ...baseAssistant };
  delete assistant.firstMessage;
  assistant.firstMessageMode = 'assistant-speaks-first-with-model-generated-message';
  assistant.model = {
    ...model,
    messages: [
      ...systemMessages,
      { role: 'system', content: buildResumeNote(priorConversation, hold) },
      { role: 'user', content: humanUtterance },
    ],
  };
  assistant.analysisPlan = withPriorTranscript(
    asObject(baseAssistant.analysisPlan),
    priorConversation
  );
  return assistant;
}

export function segmentAnalysisReady(call: Json, now: Date = new Date()): boolean {
  if (call.status !== 'ended') return false;
  if (Object.keys(asObject(call.analysis)).length > 0) return true;
  const endedAt = Date.parse(asString(call.endedAt) || asString(call.updatedAt));
  return Number.isFinite(endedAt) && now.getTime() - endedAt > ANALYSIS_GRACE_MS;
}

function compositeStatus(session: PhoneCallSessionRecord, last: Json, now: Date): string {
  const lastStatus = asString(last.status);
  if (session.state === 'ended') {
    if (lastStatus !== 'in-progress' && lastStatus !== 'ended') return 'ended';
    return segmentAnalysisReady(last, now) ? 'ended' : 'in-progress';
  }
  if (session.state === 'dialing') return 'queued';
  if (session.state === 'connected' && session.segments.length === 1 && lastStatus !== 'ended') {
    return lastStatus === '' ? 'queued' : lastStatus;
  }
  return 'in-progress';
}

function segmentSeconds(call: Json): number {
  const started = Date.parse(asString(call.startedAt));
  const ended = Date.parse(asString(call.endedAt));
  if (!Number.isFinite(started)) return 0;
  const end = Number.isFinite(ended) ? ended : Date.now();
  return Math.max(0, Math.round((end - started) / 1000));
}

/**
 * Each hold follows the segment that parked it, so a call that ended on hold or
 * while reconnecting has as many holds as segments and outlived its last
 * segment. Otherwise the last segment's own end is the line's end; the session
 * stamp can lag it when only the reconcile poll observed the hangup.
 */
function compositeEndedAt(session: PhoneCallSessionRecord, last: Json, now: Date): string {
  const segmentEnd = asString(last.endedAt);
  const endedOffSegment =
    session.holds.length > 0 && session.holds.length >= session.segments.length;
  if (!endedOffSegment && segmentEnd !== '') return segmentEnd;
  return session.endedAt?.toISOString() ?? (segmentEnd || now.toISOString());
}

function holdSummaries(session: PhoneCallSessionRecord, now: Date): Json[] {
  return session.holds.map((hold) => ({
    startedAt: hold.startedAt,
    endedAt: hold.endedAt ?? null,
    durationSeconds: Math.round(holdDurationSeconds(hold, now)),
    heard: hold.heard ?? null,
    humanUtterance: hold.humanUtterance ?? null,
    utteranceCount: hold.utterances.length,
    recentUtterances: hold.utterances.slice(-3).map((utterance) => utterance.text),
  }));
}

/** One call object in Vapi's shape, merged across segments, plus `phoneHold`. */
export function buildCompositeCall(
  session: PhoneCallSessionRecord,
  calls: Json[],
  now: Date = new Date()
): Json {
  const first = calls[0] ?? {};
  const last = calls[calls.length - 1] ?? {};
  const status = compositeStatus(session, last, now);
  const transcriptParts: string[] = [];
  calls.forEach((call, index) => {
    const transcript = asString(call.transcript).trim();
    if (transcript !== '') transcriptParts.push(transcript);
    const hold = session.holds[index];
    if (hold !== undefined) transcriptParts.push(holdMarker(hold, now));
  });
  const transcript = transcriptParts.join('\n');
  const messages = calls.flatMap((call) => {
    const own = asArray(call.messages);
    return own.length > 0 ? own : asArray(asObject(call.artifact).messages);
  });
  const segmentRows = calls.map((call, index) => ({
    vapiCallId: session.segments[index]?.vapiCallId ?? asString(call.id),
    status: asString(call.status),
    startedAt: call.startedAt ?? null,
    endedAt: call.endedAt ?? null,
    durationSeconds: segmentSeconds(call),
    endedReason: call.endedReason ?? null,
    cost: typeof call.cost === 'number' ? call.cost : 0,
  }));
  const ended = status === 'ended';
  return {
    id: session.rootVapiCallId,
    type: 'outboundPhoneCall',
    status,
    phoneCallProvider: 'twilio',
    phoneCallProviderId: session.twilioCallSid,
    customer: first.customer ?? { number: session.toNumber },
    startedAt: first.startedAt ?? session.createdAt.toISOString(),
    ...(ended
      ? {
          endedAt: compositeEndedAt(session, last, now),
          endedReason: session.endedReason ?? last.endedReason ?? 'unknown',
        }
      : {}),
    transcript,
    messages,
    artifact: { messages, transcript, recordingUrl: last.recordingUrl },
    analysis: last.analysis ?? {},
    summary: last.summary,
    recordingUrl: last.recordingUrl,
    ...(session.state === 'connected' && last.status === 'in-progress'
      ? { monitor: last.monitor }
      : {}),
    cost: segmentRows.reduce((total, row) => total + row.cost, 0),
    phoneHold: {
      sessionId: session.id,
      state: session.state,
      holds: holdSummaries(session, now),
      segments: segmentRows,
      holdSeconds: Math.round(
        session.holds.reduce((total, hold) => total + holdDurationSeconds(hold, now), 0)
      ),
      assistantSeconds: segmentRows.reduce((total, row) => total + row.durationSeconds, 0),
    },
  };
}
