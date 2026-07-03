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

// Base system prompt that gets combined with the LLM-defined system_prompt
export const BASE_SYSTEM_PROMPT = `You are making an outbound phone call. Be polite, professional, and conversational.
If the person is busy or uninterested, thank them for their time and end the call.
Extract the information defined in your output schema through natural conversation.
When the conversation goal is complete, say a brief goodbye and use the endCall tool.

`;

export const DEFAULT_CALL_ASSISTANT_CONFIG: JsonObject = {
  name: 'Rose Outbound Call Agent',
  model: {
    provider: 'openai',
    model: 'gpt-4o',
    tools: [{ type: 'endCall' }],
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
  voiceId?: string
): JsonObject {
  const configuredAssistant = DEFAULT_CALL_ASSISTANT_CONFIG;
  const configuredModel = isJsonObject(configuredAssistant.model) ? configuredAssistant.model : {};
  const configuredVoice = isJsonObject(configuredAssistant.voice) ? configuredAssistant.voice : {};
  const configuredAnalysisPlan = isJsonObject(configuredAssistant.analysisPlan)
    ? configuredAssistant.analysisPlan
    : {};

  return {
    ...configuredAssistant,
    model: {
      ...configuredModel,
      messages: [{ role: 'system', content: systemPrompt }],
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
