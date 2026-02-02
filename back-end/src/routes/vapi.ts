import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

const VAPI_BASE_URL = 'https://api.vapi.ai';

// Pool of outbound phone numbers for load distribution
// Randomly selecting from pool helps avoid spam flags and per-number rate limits
const OUTBOUND_PHONE_NUMBER_POOL = [
  '632d5264-34f2-4bf4-a4e3-3822b11adcf1', // +1 (415) 449-8445
  '2fe93786-c619-4a57-8a74-710f87b7b13b', // +1 (415) 941-6744
];

function getRandomPhoneNumberId(): string {
  const index = Math.floor(Math.random() * OUTBOUND_PHONE_NUMBER_POOL.length);
  return OUTBOUND_PHONE_NUMBER_POOL[index];
}

/**
 * Normalize JSON Schema to ensure it has a valid format for Vapi
 *
 * Handles malformed schemas like {"field_name": "description"} and converts them
 * to proper JSON Schema format {"type": "object", "properties": {"field_name": {"type": "string", "description": "..."}}}
 */
function normalizeJsonSchema(schema: Record<string, any>): Record<string, any> {
  // If schema already has a valid type, return as-is
  const validTypes = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
  if (schema.type && validTypes.includes(schema.type)) {
    return schema;
  }

  // If schema has properties but no type, it's meant to be an object
  if (schema.properties && !schema.type) {
    return { type: 'object', ...schema };
  }

  // Check if schema is malformed: {"field_name": "description", ...}
  // i.e., keys are field names and values are string descriptions
  const keys = Object.keys(schema);
  if (keys.length > 0 && keys.every(k => typeof schema[k] === 'string')) {
    // Convert to proper JSON Schema format
    const properties: Record<string, any> = {};
    for (const key of keys) {
      properties[key] = {
        type: 'string',
        description: schema[key],
      };
    }
    return {
      type: 'object',
      properties,
    };
  }

  // Default to object type if no type specified
  return { type: 'object', ...schema };
}

/**
 * Normalize phone number to E.164 format (+1XXXXXXXXXX for US numbers)
 */
function normalizePhoneNumber(number: string): string {
  // Strip all non-digit characters
  const digits = number.replace(/\D/g, '');

  // Handle 11-digit US numbers (with leading 1)
  if (digits.length === 11 && digits.startsWith('1')) {
    return '+' + digits;
  }

  // Handle 10-digit US numbers (without country code)
  if (digits.length === 10) {
    return '+1' + digits;
  }

  // If already has + prefix, return as-is
  if (number.startsWith('+')) {
    return number;
  }

  // Otherwise prepend + and return
  return '+' + digits;
}

// Base system prompt that gets combined with the LLM-defined system_prompt
const BASE_SYSTEM_PROMPT = `You are making an outbound phone call. Be polite, professional, and conversational.
If the person is busy or uninterested, thank them for their time and end the call.
Extract the information defined in your output schema through natural conversation.

`;

interface CreateCallRequest {
  to: string;
  system_prompt: string;
  output_schema: Record<string, any>;
}

interface VapiCallResponse {
  id: string;
  status: string;
  [key: string]: any;
}

/**
 * Initiate an outbound phone call via Vapi
 * POST /api/vapi/call
 * Auth: API Key (internal - called by agent worker)
 *
 * Body:
 *   - to: string (E.164 format phone number)
 *   - system_prompt: string (LLM-defined behavior instructions)
 *   - output_schema: object (JSON Schema for structured data extraction)
 *
 * Returns: { call_id, status }
 */
router.post('/call', authenticate, async (req: AuthRequest, res) => {
  try {
    const { to, system_prompt, output_schema } = req.body as CreateCallRequest;

    // Validate input
    if (!to) {
      return res.status(400).json({ error: 'to (phone number) is required' });
    }
    if (!system_prompt) {
      return res.status(400).json({ error: 'system_prompt is required' });
    }
    if (!output_schema) {
      return res.status(400).json({ error: 'output_schema is required' });
    }

    const vapiPrivateKey = process.env.VAPI_PRIVATE_KEY;

    if (!vapiPrivateKey) {
      console.error('VAPI_PRIVATE_KEY not configured');
      return res.status(500).json({ error: 'Vapi not configured' });
    }

    // Randomly select a phone number from the pool
    const phoneNumberId = getRandomPhoneNumberId();

    // Combine base prompt with LLM-defined system_prompt
    const fullSystemPrompt = BASE_SYSTEM_PROMPT + system_prompt;

    // Normalize phone number to E.164 format
    const normalizedPhone = normalizePhoneNumber(to);

    // Ensure output_schema is a valid JSON Schema with type field
    const normalizedSchema = normalizeJsonSchema(output_schema);

    // Create outbound call via Vapi API
    const response = await fetch(`${VAPI_BASE_URL}/call`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${vapiPrivateKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phoneNumberId: phoneNumberId,
        customer: {
          number: normalizedPhone,
        },
        assistant: {
          model: {
            provider: 'openai',
            model: 'gpt-4o',
            messages: [
              { role: 'system', content: fullSystemPrompt }
            ],
          },
          voice: {
            provider: '11labs',
            voiceId: 'paula', // Default voice - can be made configurable later
          },
          firstMessage: 'Hello, how are you today?',
          analysisPlan: {
            structuredDataPlan: {
              enabled: true,
              schema: normalizedSchema,
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Vapi API error:', response.status, errorText);
      return res.status(response.status).json({
        error: `Vapi API error (${response.status})`,
        details: errorText,
      });
    }

    const result = (await response.json()) as VapiCallResponse;

    console.log('✅ Vapi call initiated', {
      callId: result.id,
      to: to.substring(0, 4) + '****',
      status: result.status,
    });

    res.json({
      success: true,
      call_id: result.id,
      status: result.status,
    });

  } catch (error) {
    console.error('Error initiating Vapi call:', error);
    res.status(500).json({ error: 'Failed to initiate call' });
  }
});

/**
 * Poll call status from Vapi
 * GET /api/vapi/call/:id
 * Auth: API Key (internal - called by agent worker)
 *
 * Returns: Full Vapi call response (status, duration, transcript, structuredData, etc.)
 */
router.get('/call/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'call id is required' });
    }

    const vapiPrivateKey = process.env.VAPI_PRIVATE_KEY;

    if (!vapiPrivateKey) {
      console.error('VAPI_PRIVATE_KEY not configured');
      return res.status(500).json({ error: 'Vapi not configured' });
    }

    // Get call status from Vapi API
    const response = await fetch(`${VAPI_BASE_URL}/call/${id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${vapiPrivateKey}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Vapi API error:', response.status, errorText);
      return res.status(response.status).json({
        error: `Vapi API error (${response.status})`,
        details: errorText,
      });
    }

    const result = await response.json() as Record<string, unknown>;

    // Log full response for debugging
    console.log('Vapi call poll response', {
      callId: id,
      status: result.status,
      duration: result.duration,
      endedReason: result.endedReason,
      // Log full result for debugging during development
      fullResponse: JSON.stringify(result),
    });

    res.json(result);

  } catch (error) {
    console.error('Error polling Vapi call:', error);
    res.status(500).json({ error: 'Failed to poll call status' });
  }
});

export default router;
