export const VAPI_BASE_URL = 'https://api.vapi.ai';
export const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;

// Pool of outbound phone numbers for load distribution
// Randomly selecting from pool helps avoid spam flags and per-number rate limits
export const OUTBOUND_PHONE_NUMBER_POOL = [
  '632d5264-34f2-4bf4-a4e3-3822b11adcf1', // +1 (415) 449-8445
  '2fe93786-c619-4a57-8a74-710f87b7b13b', // +1 (415) 941-6744
];

// Base system prompt that gets combined with the LLM-defined system_prompt
export const BASE_SYSTEM_PROMPT = `You are making an outbound phone call. Be polite, professional, and conversational.
If the person is busy or uninterested, thank them for their time and end the call.
Extract the information defined in your output schema through natural conversation.

`;
