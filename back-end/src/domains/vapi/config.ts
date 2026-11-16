export const VAPI_BASE_URL = process.env.VAPI_API_BASE_URL ?? 'https://api.vapi.ai';
export const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;

type JsonObject = Record<string, unknown>;

export interface OutboundPhoneNumber {
  /** Vapi phone-number id (imported Twilio number). */
  id: string;
  /** Same number in E.164, used when the backend dials it on Twilio directly. */
  number: string;
}

// Pool of outbound phone numbers for load distribution.
// Randomly selecting from the pool helps avoid spam flags and per-number rate limits.
// +14159416744 (2fe93786-…) is excluded: it is the phone-call-payment benchmark's answering line.
export const OUTBOUND_PHONE_NUMBER_POOL: OutboundPhoneNumber[] = [
  { id: '632d5264-34f2-4bf4-a4e3-3822b11adcf1', number: '+14154498445' },
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

export const DEFAULT_CALL_ASSISTANT_CONFIG: JsonObject = {
  name: 'Rose Outbound Call Agent',
  model: {
    provider: 'openai',
    model: OUTBOUND_ASSISTANT_MODEL,
    // The model says goodbye using the call brief. Suppress Vapi's additional
    // default goodbye (which otherwise has its own language selection).
    tools: [
      { type: 'endCall', messages: [{ type: 'request-start', content: '' }] },
      { type: 'dtmf' },
    ],
  },
  voice: {
    provider: '11labs',
    voiceId: DEFAULT_OUTBOUND_VOICE_ID,
    model: 'eleven_turbo_v2_5',
  },
  transcriber: {
    provider: 'deepgram',
    model: 'nova-3',
    language: 'multi',
  },
  // Generate the opening from the same per-call instructions as later turns.
  firstMessageMode: 'assistant-speaks-first-with-model-generated-message',
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

// ── wait_for_human: park the call on a backend media stream while on hold ──

export const WAIT_FOR_HUMAN_TOOL_NAME = 'wait_for_human';

export const WAIT_FOR_HUMAN_TOOL_DESCRIPTION =
  'Put this call on hold until a live person picks up. Use it as soon as you are waiting in a hold queue: hold music, recorded "please stay on the line" or estimated-wait announcements, and no live person talking with you. While on hold you stop listening, the line stays connected, and you are reconnected automatically, with what the person said, as soon as a live person starts talking. Do not use it while an automated menu is still asking you for input, and do not hang up just because the wait is long.';

/** URL prefix of the hold webhooks; the router is mounted at /api/vapi. */
export const HOLD_ROUTE_PREFIX = '/api/vapi/hold';
export const HOLD_STREAM_PATH = `${HOLD_ROUTE_PREFIX}/stream`;

/** Absolute hold ceiling: a parked call is hung up after this long. */
export const HOLD_MAX_SECONDS = Number(process.env.PHONE_HOLD_MAX_SECONDS ?? 3 * 60 * 60);
/** Hold transcripts kept per hold period (oldest dropped first). */
export const HOLD_UTTERANCE_LIMIT = 40;
/** Earlier hold utterances shown to the human detector with each new one. */
export const HOLD_DETECTOR_CONTEXT_UTTERANCES = 12;
/** Twilio <Redirect> re-connects of the hold stream before giving up. */
export const HOLD_STREAM_RECONNECT_LIMIT = 30;
/** Audio batched per realtime STT frame (Twilio sends 20 ms μ-law frames). */
export const HOLD_STT_CHUNK_MS = 200;
export const HOLD_PRIOR_TRANSCRIPT_CHAR_LIMIT = 12_000;

export const TWILIO_API_BASE_URL = process.env.TWILIO_API_BASE_URL ?? 'https://api.twilio.com';
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
export const ELEVENLABS_REALTIME_STT_URL =
  process.env.ELEVENLABS_REALTIME_STT_URL ?? 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
export const HUMAN_DETECTOR_MODEL = 'rose-labs/rose-1-mini';

export interface HoldRuntimeConfig {
  publicBaseUrl: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  elevenLabsApiKey: string;
  tokenSecret: string;
}

/**
 * Public https origin that Twilio and Vapi can reach for hold webhooks.
 * Local stacks expose the frontend tunnel (Vite proxies /api, including
 * websockets); production uses the backend's own public URL. Loopback or
 * plain-http values are unreachable from Twilio and disable hold parking.
 */
export function resolveHoldPublicBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.PHONE_HOLD_PUBLIC_URL,
    env.PUBLIC_BASE_URL,
    env.BACKEND_URL,
    env.RENDER_EXTERNAL_URL,
  ];
  for (const raw of candidates) {
    const value = (raw ?? '').trim().replace(/\/+$/, '');
    if (value === '' || !value.startsWith('https://')) continue;
    const host = value.slice('https://'.length).split(/[/:]/)[0].toLowerCase();
    if (host === 'localhost' || host.startsWith('127.') || host === '0.0.0.0' || host === '[') {
      continue;
    }
    return value;
  }
  return null;
}

/** Null when any dependency of hold parking is missing (calls then use Vapi directly). */
export function resolveHoldRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): HoldRuntimeConfig | null {
  if (env.PHONE_HOLD_ENABLED === '0') return null;
  const publicBaseUrl = resolveHoldPublicBaseUrl(env);
  const twilioAccountSid = env.TWILIO_ACCOUNT_SID ?? '';
  const twilioAuthToken = env.TWILIO_AUTH_TOKEN ?? '';
  const elevenLabsApiKey = env.ELEVENLABS_API_KEY ?? '';
  const tokenSecret = env.BACKEND_API_KEY ?? '';
  if (
    publicBaseUrl === null ||
    twilioAccountSid === '' ||
    twilioAuthToken === '' ||
    elevenLabsApiKey === '' ||
    tokenSecret === ''
  ) {
    return null;
  }
  return { publicBaseUrl, twilioAccountSid, twilioAuthToken, elevenLabsApiKey, tokenSecret };
}

export function buildWaitForHumanTool(serverUrl: string): JsonObject {
  return {
    type: 'function',
    function: {
      name: WAIT_FOR_HUMAN_TOOL_NAME,
      description: WAIT_FOR_HUMAN_TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          heard: {
            type: 'string',
            description: 'What you heard that shows you are on hold.',
          },
        },
        required: [],
      },
    },
    server: { url: serverUrl, timeoutSeconds: 20 },
  };
}

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
  options?: { calleeSpeaksFirst?: boolean; waitForHumanToolUrl?: string }
): JsonObject {
  const configuredAssistant = DEFAULT_CALL_ASSISTANT_CONFIG;
  const configuredModel = isJsonObject(configuredAssistant.model) ? configuredAssistant.model : {};
  const configuredVoice = isJsonObject(configuredAssistant.voice) ? configuredAssistant.voice : {};
  const configuredAnalysisPlan = isJsonObject(configuredAssistant.analysisPlan)
    ? configuredAssistant.analysisPlan
    : {};
  const configuredTools = Array.isArray(configuredModel.tools) ? configuredModel.tools : [];
  // IVR callees speak first (menu prompt). Greeting over the menu wastes the
  // turn and makes the outbound agent less likely to send DTMF immediately.
  // Detect from the caller-provided brief only (see isIvrNavigationPrompt).
  const calleeSpeaksFirst =
    options?.calleeSpeaksFirst === true || isIvrNavigationPrompt(systemPrompt);

  return {
    ...configuredAssistant,
    ...(calleeSpeaksFirst
      ? {
          firstMessage: '',
          firstMessageMode: 'assistant-waits-for-user',
        }
      : {}),
    model: {
      ...configuredModel,
      messages: [{ role: 'system', content: systemPrompt }],
      tools:
        options?.waitForHumanToolUrl !== undefined
          ? [...configuredTools, buildWaitForHumanTool(options.waitForHumanToolUrl)]
          : configuredTools,
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
