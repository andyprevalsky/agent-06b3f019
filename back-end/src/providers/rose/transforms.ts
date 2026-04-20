/**
 * Provider-shape transforms for the Rose client.
 *
 * Slim port of agents/providers/rose/transforms.py covering only the chat
 * surface: no tool calls, no native-tool extraction, no vision marker
 * expansion. Chat callers pass plain message arrays + an OpenAI-shaped
 * response_format.
 */

import type { CompletionMessage, ContentBlock, ResponseFormat } from './types';

const DATA_URI_RE = /^data:([^;]+);base64,([\s\S]+)$/;

function transformContentBlockForAnthropic(block: ContentBlock): unknown {
  if (!block || typeof block !== 'object') return block;

  if (block.type === 'image_url' && block.image_url?.url) {
    const url = block.image_url.url;
    if (url.startsWith('data:')) {
      const match = DATA_URI_RE.exec(url);
      if (match) {
        const [, mediaType, data] = match;
        return {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data },
        };
      }
    }
    return { type: 'image', source: { type: 'url', url } };
  }

  if (block.type === 'file' && block.file?.file_data?.startsWith('data:')) {
    const match = DATA_URI_RE.exec(block.file.file_data);
    if (match) {
      const [, mediaType, data] = match;
      return {
        type: 'document',
        source: { type: 'base64', media_type: mediaType, data },
      };
    }
  }

  return block;
}

export interface AnthropicMessages {
  systemText: string | null;
  messages: Array<{ role: string; content: unknown }>;
}

/**
 * OpenAI-style messages → (system_text, anthropic_messages).
 *
 * Slim port: chat callers don't have assistant tool_calls or tool-role
 * messages, so we don't handle them. If a caller needs them, copy the
 * Python implementation.
 */
export function transformMessagesForAnthropic(messages: CompletionMessage[]): AnthropicMessages {
  const systemParts: string[] = [];
  const out: Array<{ role: string; content: unknown }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      systemParts.push(content);
      continue;
    }

    if (Array.isArray(msg.content)) {
      out.push({
        role: msg.role,
        content: msg.content.map(transformContentBlockForAnthropic),
      });
    } else {
      out.push({ role: msg.role, content: msg.content });
    }
  }

  while (out.length > 0 && out[out.length - 1].role === 'assistant') {
    out.pop();
  }

  return {
    systemText: systemParts.length > 0 ? systemParts.join('\n\n') : null,
    messages: out,
  };
}

const UNSUPPORTED_SCHEMA_KEYS = [
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'multipleOf',
  'minItems',
  'maxItems',
];

/**
 * Strip JSON-schema constraints Anthropic's structured-output validator
 * rejects. Recurses into properties / items / $defs / anyOf / oneOf / allOf.
 */
type JsonSchema = Record<string, unknown>;

export function transformSchemaForAnthropic(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;

  const out: JsonSchema = { ...(schema as JsonSchema) };
  for (const key of UNSUPPORTED_SCHEMA_KEYS) {
    delete out[key];
  }

  if (
    out.type === 'object' &&
    out.additionalProperties &&
    typeof out.additionalProperties === 'object'
  ) {
    // `additionalProperties: { ... }` means "dictionary with typed values".
    // Keep the map shape but recurse so unsupported nested keywords are
    // still stripped. Don't flatten to `false`, which would break every
    // map-typed field on the claudeAuth path.
    out.additionalProperties = transformSchemaForAnthropic(out.additionalProperties);
  }

  if (out.properties && typeof out.properties === 'object') {
    const newProps: JsonSchema = {};
    for (const [k, v] of Object.entries(out.properties as JsonSchema)) {
      newProps[k] = transformSchemaForAnthropic(v);
    }
    out.properties = newProps;
  }

  if (out.items) {
    out.items = transformSchemaForAnthropic(out.items);
  }

  if (out.$defs && typeof out.$defs === 'object') {
    const newDefs: JsonSchema = {};
    for (const [k, v] of Object.entries(out.$defs as JsonSchema)) {
      newDefs[k] = transformSchemaForAnthropic(v);
    }
    out.$defs = newDefs;
  }

  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(out[keyword])) {
      out[keyword] = (out[keyword] as unknown[]).map(transformSchemaForAnthropic);
    }
  }

  return out;
}

/**
 * Mutate `body` to encode an OpenAI-shaped response_format as the Anthropic
 * `output_config` field (claudeAuth path).
 */
export function applyAnthropicResponseFormat(
  body: Record<string, unknown>,
  responseFormat?: ResponseFormat
): void {
  if (!responseFormat?.json_schema?.schema) return;
  const schema = transformSchemaForAnthropic(responseFormat.json_schema.schema);
  body.output_config = {
    format: { type: 'json_schema', schema },
  };
}
