import { createLogger } from '../../providers/logger';
import { findUser } from '../user-settings/repo';

const log = createLogger('VapiHelpers');

const DEFAULT_SYSTEM_NAME = 'Rose';

/**
 * Normalize JSON Schema to ensure it has a valid format for Vapi
 *
 * Handles malformed schemas like {"field_name": "description"} and converts them
 * to proper JSON Schema format.
 */
export function normalizeJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const validTypes = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
  if (typeof schema.type === 'string' && validTypes.includes(schema.type)) {
    return schema;
  }

  // If schema has properties but no type, it's meant to be an object
  if (schema.properties !== undefined && schema.type === undefined) {
    return { type: 'object', ...schema };
  }

  // Check if schema is malformed: {"field_name": "description", ...}
  const keys = Object.keys(schema);
  if (keys.length > 0 && keys.every((k) => typeof schema[k] === 'string')) {
    const properties: Record<string, unknown> = {};
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
export function normalizePhoneNumber(number: string): string {
  const digits = number.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return '+' + digits;
  }
  if (digits.length === 10) {
    return '+1' + digits;
  }
  if (number.startsWith('+')) {
    return number;
  }
  return '+' + digits;
}

export async function lookupUserVoiceAndName(
  userId: string | undefined
): Promise<{ systemName: string; voiceId?: string }> {
  if (userId === undefined || userId === '') {
    return { systemName: DEFAULT_SYSTEM_NAME };
  }
  try {
    const user = await findUser(userId);
    return {
      systemName:
        user?.systemName !== null && user?.systemName !== undefined && user.systemName !== ''
          ? user.systemName
          : DEFAULT_SYSTEM_NAME,
      voiceId:
        user?.voicePreferenceId !== null &&
        user?.voicePreferenceId !== undefined &&
        user.voicePreferenceId !== ''
          ? user.voicePreferenceId
          : undefined,
    };
  } catch (err) {
    log.warn('Failed to load user for Vapi call; using defaults', {
      userId: userId.substring(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    return { systemName: DEFAULT_SYSTEM_NAME };
  }
}
