export const VAPI_BASE_URL = 'https://api.vapi.ai';
export const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;

type JsonObject = Record<string, unknown>;

// Pool of outbound phone numbers for load distribution.
// Randomly selecting from the pool helps avoid spam flags and per-number rate limits.
export const OUTBOUND_PHONE_NUMBER_POOL = [
  '632d5264-34f2-4bf4-a4e3-3822b11adcf1', // +1 (415) 449-8445
  '2fe93786-c619-4a57-8a74-710f87b7b13b', // +1 (415) 941-6744
];

// Default ElevenLabs voice ID for outbound calls — "Rose", the first preset
// in mac-app/ui/features/onboarding/components/VoiceSelector.tsx
// (PRESET_VOICES[0]). Used when the user has not selected a custom voice.
export const DEFAULT_OUTBOUND_VOICE_ID = '6fZce9LFNG3iEITDfqZZ';

export const OUTBOUND_ASSISTANT_MODEL = 'gpt-4.1-mini';

// Base system prompt that gets combined with the LLM-defined system_prompt
export const BASE_SYSTEM_PROMPT = `You are making an outbound phone call. Be polite, professional, and conversational.
If the person is busy or uninterested, thank them for their time and end the call.
Extract the information defined in your output schema through natural conversation.
When you reach an automated phone menu or IVR that asks you to press a button or enter digits on the keypad, use the dtmf function to send keypad tones. Never speak digits aloud or say "press one" — send the actual tones. For a single menu digit, send just that digit (for example keys: "2"). For multi-digit entry ending in #, wait until the prompt finishes, then send one dtmf call with a short leading pause and light grouping pauses so the IVR can register tones (for example keys: "ww245w133w8820#"). Do not put a w pause between every single digit, and do not omit pauses entirely on long sequences.
After you send DTMF, stay silent and listen for the IVR's next prompt or result. Do not hang up on an intermediate retry prompt; wait for the information you need (or a clear final failure) before using endCall.
When the conversation goal is complete, say a brief goodbye and use the endCall tool.

`;

/**
 * True when the *caller-provided* call brief is navigating an automated menu.
 * Must NOT match {@link BASE_SYSTEM_PROMPT} alone — that text always mentions
 * DTMF/IVR as general guidance for every outbound call.
 */
export function isIvrNavigationPrompt(systemPrompt: string): boolean {
  const hasMenuNav = /\b(dtmf|ivr|keypad|phone menu|call tree|automated (?:phone )?menu)\b/i.test(
    systemPrompt
  );
  const hasDigitEntryGoal =
    /\b(tracking number|track (?:a )?package|account number|pound key|followed by #|enter (?:the |your )?\d|press (?:the )?\d)/i.test(
      systemPrompt
    );
  return hasMenuNav && hasDigitEntryGoal;
}

/**
 * True when the caller-provided brief is waiting on a hold queue.
 * Must NOT match {@link BASE_SYSTEM_PROMPT} alone — that text says
 * "stay silent" / "do not hang up" for IVR retries, not hold queues.
 */
export function isHoldQueuePrompt(systemPrompt: string): boolean {
  return /\b(on hold|hold queue|stay on the line|estimated wait|please hold)\b/i.test(
    systemPrompt
  );
}

// Long enough for a 3-hour hold plus the post-hold conversation. Keepalives
// on the callee leg reset silence before this 1-hour caller silence budget.
export const HOLD_QUEUE_SILENCE_TIMEOUT_SECONDS = 3600;
export const HOLD_QUEUE_MAX_DURATION_SECONDS = 12600;

export const DEFAULT_CALL_ASSISTANT_CONFIG: JsonObject = {
  name: 'Rose Outbound Call Agent',
  model: {
    provider: 'openai',
    model: OUTBOUND_ASSISTANT_MODEL,
    tools: [{ type: 'endCall' }, { type: 'dtmf' }],
  },
  voice: {
    provider: '11labs',
    voiceId: DEFAULT_OUTBOUND_VOICE_ID,
  },
  transcriber: {
    provider: 'deepgram',
    model: 'flux-general-en',
    language: 'en',
    eotThreshold: 0.7,
    eotTimeoutMs: 5000,
  },
  firstMessage: 'Hello, how are you today?',
  endCallMessage: 'Thank you for your time. Goodbye.',
  silenceTimeoutSeconds: 30,
  maxDurationSeconds: 600,
  analysisPlan: {
    summaryPlan: {
      enabled: true,
    },
    successEvaluationPlan: {
      enabled: false,
    },
  },
  serverMessages: ['end-of-call-report', 'status-update', 'hang'],
  clientMessages: ['transcript', 'hang', 'speech-update', 'metadata', 'conversation-update'],
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMergeJson(base: JsonObject, overrides: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };

  for (const [key, overrideValue] of Object.entries(overrides)) {
    const baseValue = merged[key];
    if (isJsonObject(baseValue) && isJsonObject(overrideValue)) {
      merged[key] = deepMergeJson(baseValue, overrideValue);
      continue;
    }
    merged[key] = overrideValue;
  }

  return merged;
}

export function buildCallAssistantConfig(
  systemPrompt: string,
  structuredDataSchema: Record<string, unknown>,
  voiceId?: string,
  options?: { calleeSpeaksFirst?: boolean }
): JsonObject {
  const configuredAssistant = DEFAULT_CALL_ASSISTANT_CONFIG;
  const configuredModel = isJsonObject(configuredAssistant.model) ? configuredAssistant.model : {};
  const configuredVoice = isJsonObject(configuredAssistant.voice) ? configuredAssistant.voice : {};
  const configuredAnalysisPlan = isJsonObject(configuredAssistant.analysisPlan)
    ? configuredAssistant.analysisPlan
    : {};
  // IVR callees speak first (menu prompt). Greeting over the menu wastes the
  // turn and makes the outbound agent less likely to send DTMF immediately.
  // Detect from the caller-provided brief only (see isIvrNavigationPrompt).
  const calleeSpeaksFirst =
    options?.calleeSpeaksFirst === true ||
    isIvrNavigationPrompt(systemPrompt) ||
    isHoldQueuePrompt(systemPrompt);

  const holdQueue = isHoldQueuePrompt(systemPrompt);

  return {
    ...configuredAssistant,
    ...(calleeSpeaksFirst
      ? {
          firstMessage: '',
          firstMessageMode: 'assistant-waits-for-user',
        }
      : {}),
    ...(holdQueue
      ? {
          silenceTimeoutSeconds: HOLD_QUEUE_SILENCE_TIMEOUT_SECONDS,
          maxDurationSeconds: HOLD_QUEUE_MAX_DURATION_SECONDS,
        }
      : {}),
    model: {
      ...configuredModel,
      messages: [{ role: 'system', content: systemPrompt }],
      // Hold-queue callers must not be able to hang up during a multi-hour
      // wait. The callee persona ends the call after the live representative
      // conversation. Mutating a copy — never DEFAULT_CALL_ASSISTANT_CONFIG.
      ...(holdQueue
        ? {
            tools: (Array.isArray(configuredModel.tools) ? configuredModel.tools : []).filter(
              (tool) => !isJsonObject(tool) || tool.type !== 'endCall'
            ),
          }
        : {}),
    },
    voice: {
      ...configuredVoice,
      ...(voiceId !== undefined && voiceId !== '' ? { voiceId } : {}),
    },
    analysisPlan: deepMergeJson(configuredAnalysisPlan, {
      structuredDataPlan: {
        enabled: true,
        schema: structuredDataSchema,
      },
    }),
  };
}
