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

const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n';

export interface AnthropicMessages {
  staticSystem: string | null;
  dynamicSystem: string | null;
  messages: Array<{ role: string; content: unknown }>;
}

/**
 * OpenAI-style messages → (staticSystem, dynamicSystem, anthropic_messages).
 *
 * System messages are concatenated and split at SYSTEM_PROMPT_DYNAMIC_BOUNDARY
 * into static (globally cacheable) and dynamic (per-call) portions.
 *
 * Assistant tool calls and tool results are converted to Anthropic's native
 * tool_use/tool_result blocks. This lets callers inject run-local runtime
 * context after a user turn without mislabeling it as user-authored text.
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

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map(transformContentBlockForAnthropic);
      if (typeof text === 'string' ? text.length > 0 : text.length > 0) {
        if (typeof text === 'string') blocks.push({ type: 'text', text });
        else blocks.push(...(text as Array<Record<string, unknown>>));
      }
      for (const [index, toolCall] of msg.tool_calls.entries()) {
        const name = toolCall.function?.name ?? toolCall.name ?? 'tool';
        const rawArguments = toolCall.function?.arguments ?? toolCall.arguments ?? {};
        let input: unknown = rawArguments;
        if (typeof rawArguments === 'string') {
          try {
            input = JSON.parse(rawArguments);
          } catch {
            input = {};
          }
        }
        blocks.push({
          type: 'tool_use',
          id: toolCall.id ?? toolCall.call_id ?? `tool-call-${index}`,
          name,
          input,
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    if (msg.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id ?? msg.call_id ?? 'tool-call',
            content:
              typeof msg.content === 'string'
                ? msg.content
                : msg.content.map(transformContentBlockForAnthropic),
          },
        ],
      });
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

  const systemText = systemParts.length > 0 ? systemParts.join('\n\n') : null;

  let staticSystem: string | null = null;
  let dynamicSystem: string | null = null;
  if (systemText && systemText.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) {
    const idx = systemText.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    staticSystem = systemText.slice(0, idx).trim() || null;
    dynamicSystem = systemText.slice(idx + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length).trim() || null;
  } else {
    staticSystem = systemText;
  }

  return { staticSystem, dynamicSystem, messages: out };
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

  if (out.type === 'object' && out.additionalProperties !== undefined) {
    if (typeof out.additionalProperties === 'object') {
      // `additionalProperties: { ... }` means "dictionary with typed values".
      // Keep the map shape but recurse so unsupported nested keywords are
      // still stripped. Don't flatten to `false`, which would break every
      // map-typed field on the claudeAuth path.
      out.additionalProperties = transformSchemaForAnthropic(out.additionalProperties);
    } else if (out.additionalProperties === true) {
      // Anthropic's structured-output validator rejects explicit
      // `additionalProperties: true` ("For 'object' type, ... is not
      // supported. Please set 'additionalProperties' to false"). Setting
      // it to false satisfies the validator; the model still emits
      // whatever fields it produces, and downstream consumers don't rely
      // on Anthropic's strict enforcement here.
      out.additionalProperties = false;
    }
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
 * `output_config` field (legacy structured-output path).
 *
 * Prefer {@link applyAnthropicToolConfig} for new code — it produces native
 * Anthropic tools, matching the agents/ runtime, which avoids the response_format
 * grammar limits and yields cleaner streaming.
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

interface ExtractedTools {
  tools: Array<Record<string, unknown>>;
  responseFieldSchema: unknown;
}

/**
 * Pull native Anthropic tools out of an OpenAI-style response_format whose
 * top-level shape is `{ properties: { tool_calls: { items: { anyOf: [...] } } } }`
 * — the supervisor / agent envelope where each anyOf variant is a tool with a
 * `tool: { const: name }` discriminator.
 *
 * Each variant is lifted into a separate Anthropic tool with the discriminator
 * dropped from the input schema. Returns null when the schema doesn't fit.
 */
export function extractToolsFromResponseFormat(
  responseFormat?: ResponseFormat | null
): ExtractedTools | null {
  if (!responseFormat) return null;
  const jsonSchema = responseFormat.json_schema;
  if (!jsonSchema || typeof jsonSchema !== 'object') return null;
  const schema = jsonSchema.schema as JsonSchema | undefined;
  if (!schema || typeof schema !== 'object') return null;

  const properties = (schema.properties as JsonSchema | undefined) ?? {};
  const toolCalls = (properties.tool_calls as JsonSchema | undefined) ?? {};
  const items = (toolCalls.items as JsonSchema | undefined) ?? {};
  const anyOf = items.anyOf;
  if (!Array.isArray(anyOf) || anyOf.length === 0) return null;

  for (const variant of anyOf) {
    if (!variant || typeof variant !== 'object') return null;
    const variantProps = (variant as JsonSchema).properties as JsonSchema | undefined;
    const toolField = variantProps?.tool as JsonSchema | undefined;
    if (!toolField || !('const' in toolField)) return null;
  }

  const tools: Array<Record<string, unknown>> = [];
  for (const variant of anyOf) {
    const variantObj = variant as JsonSchema;
    const variantProps = { ...((variantObj.properties as JsonSchema | undefined) ?? {}) };
    const toolName = (variantProps.tool as JsonSchema).const as string;
    const description = (variantObj.description as string | undefined) ?? '';

    delete variantProps.tool;
    const required = (((variantObj.required as unknown[] | undefined) ?? []) as string[]).filter(
      (r) => r !== 'tool'
    );

    const inputSchema: JsonSchema = {
      type: 'object',
      properties: variantProps,
      required,
    };
    if ('additionalProperties' in variantObj) {
      inputSchema.additionalProperties = variantObj.additionalProperties;
    }

    tools.push({
      name: toolName,
      description,
      input_schema: transformSchemaForAnthropic(inputSchema),
    });
  }

  const responseFieldSchema = properties.response ?? { type: 'string' };
  return { tools, responseFieldSchema };
}

/**
 * Configure an Anthropic request body for native tools / structured output.
 * Mirrors `apply_anthropic_tool_config` in agents/providers/rose/transforms.py.
 *
 * Priority:
 *   1. Explicit `tools` (claudeAuth always uses native mode): install directly,
 *      default tool_choice to "auto".
 *   2. `responseFormat.json_schema`: try to extract native tools from the
 *      envelope shape; if successful, install with tool_choice=any. Otherwise
 *      fall back to the legacy output_config structured-output path.
 *
 * Returns true iff native tool mode is active (body.tools is populated).
 */
export function applyAnthropicToolConfig(
  body: Record<string, unknown>,
  responseFormat?: ResponseFormat | null,
  tools?: Array<Record<string, unknown>> | null,
  toolChoice?: unknown
): boolean {
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      ...('strict' in t ? { strict: t.strict } : {}),
      input_schema: t.input_schema,
    }));
    body.tool_choice = normalizeAnthropicToolChoice(toolChoice) ?? { type: 'auto' };
    delete body.output_config;
    delete body.output_format;
    return true;
  }

  if (responseFormat?.json_schema && typeof responseFormat.json_schema === 'object') {
    const extracted = extractToolsFromResponseFormat(responseFormat);
    if (extracted) {
      body.tools = extracted.tools;
      body.tool_choice = normalizeAnthropicToolChoice(toolChoice) ?? { type: 'any' };
      const prevEffort = (body.output_config as Record<string, unknown> | undefined)?.effort;
      delete body.output_config;
      delete body.output_format;
      if (prevEffort) {
        body.output_config = { effort: prevEffort };
      }
      return true;
    }

    // Fallback: legacy structured output via output_config.format.
    const schema = transformSchemaForAnthropic((responseFormat.json_schema as JsonSchema).schema);
    const prevEffort = (body.output_config as Record<string, unknown> | undefined)?.effort;
    body.output_config = {
      format: { type: 'json_schema', schema },
      ...(prevEffort ? { effort: prevEffort } : {}),
    };
    return false;
  }

  return false;
}

function normalizeAnthropicToolChoice(toolChoice: unknown): Record<string, unknown> | null {
  if (toolChoice === null || toolChoice === undefined) return null;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required' || toolChoice === 'any') return { type: 'any' };
  if (
    typeof toolChoice === 'object' &&
    toolChoice !== null &&
    'function' in toolChoice &&
    typeof (toolChoice as Record<string, unknown>).function === 'object'
  ) {
    const fn = (toolChoice as { function: Record<string, unknown> }).function;
    if (typeof fn.name === 'string') {
      return { type: 'tool', name: fn.name };
    }
  }
  if (typeof toolChoice === 'object' && toolChoice !== null && 'type' in toolChoice) {
    return toolChoice as Record<string, unknown>;
  }
  return { type: 'any' };
}
