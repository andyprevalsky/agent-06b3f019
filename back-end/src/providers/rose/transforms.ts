/**
 * Provider-shape transforms for the Rose client.
 *
 * Slim port of agents/providers/rose/transforms.py covering only the chat
 * surface: no tool calls, no native-tool extraction, no vision marker
 * expansion. Chat callers pass plain message arrays + an OpenAI-shaped
 * response_format.
 */

import { canonicalTool, namedToolChoice } from './toolContract';
import type { CompletionMessage, CompletionOptions, ContentBlock, ResponseFormat } from './types';
import { isUncachedContext, markUncachedContext } from './cache';

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

    const converted = {
      role: msg.role,
      content: Array.isArray(msg.content)
        ? msg.content.map(transformContentBlockForAnthropic)
        : msg.content,
    };
    out.push(isUncachedContext(msg) ? markUncachedContext(converted) : converted);
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
 * Rewrite `anyOf: [T, {type: "null"}]` — how an OpenAI-strict schema spells
 * "optional", since strict mode requires every property — as plain `T` that is
 * absent from `required`.
 *
 * Anthropic caps a request at 16 union-typed parameters; the SMS supervisor's
 * grep tool alone declares 24, so without this every claudeAuth SMS round is
 * rejected with `invalid_request_error` and burns the paid waterfall. Anthropic
 * expresses optionality through `required`, so the collapsed schema carries the
 * same contract with no unions at all.
 */
function relaxNullableUnionsForAnthropic(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(relaxNullableUnionsForAnthropic);

  const out: JsonSchema = { ...(schema as JsonSchema) };
  const optionalKeys = new Set<string>();

  if (out.properties && typeof out.properties === 'object') {
    const newProps: JsonSchema = {};
    for (const [key, value] of Object.entries(out.properties as JsonSchema)) {
      const relaxed = relaxNullableUnionsForAnthropic(value) as JsonSchema;
      const unwrapped = unwrapNullableUnion(relaxed);
      if (unwrapped) {
        newProps[key] = unwrapped;
        optionalKeys.add(key);
      } else {
        newProps[key] = relaxed;
      }
    }
    out.properties = newProps;
  }

  if (optionalKeys.size > 0 && Array.isArray(out.required)) {
    out.required = (out.required as unknown[]).filter(
      (key) => typeof key !== 'string' || !optionalKeys.has(key)
    );
  }

  // Array items and typed-map values carry their own nullable unions, which
  // count against the same 16-union cap. Unlike a property there is no
  // `required` list to express optionality here, so the union collapses to its
  // value branch outright.
  for (const keyword of ['items', 'additionalProperties'] as const) {
    const child = out[keyword];
    if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
    const relaxed = relaxNullableUnionsForAnthropic(child) as JsonSchema;
    out[keyword] = unwrapNullableUnion(relaxed) ?? relaxed;
  }
  if (out.$defs && typeof out.$defs === 'object') {
    const newDefs: JsonSchema = {};
    for (const [key, value] of Object.entries(out.$defs as JsonSchema)) {
      newDefs[key] = relaxNullableUnionsForAnthropic(value);
    }
    out.$defs = newDefs;
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(out[keyword])) {
      out[keyword] = (out[keyword] as unknown[]).map(relaxNullableUnionsForAnthropic);
    }
  }

  return out;
}

/** Unwrap nullable unions recursively, including combined optional/nullable wrappers. */
function unwrapNullableUnion(schema: JsonSchema): JsonSchema | null {
  const branches = (Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf) as
    JsonSchema[] | undefined;
  if (!Array.isArray(branches) || branches.length !== 2) return null;
  const valueBranch = branches.find((b) => b && typeof b === 'object' && b.type !== 'null');
  const hasNullBranch = branches.some((b) => b && typeof b === 'object' && b.type === 'null');
  if (!valueBranch || !hasNullBranch) return null;

  // Optional(nullable(T)) produces nested wrappers; collapse every layer.
  const merged: JsonSchema = { ...(unwrapNullableUnion(valueBranch) ?? valueBranch) };
  // The description hangs off the union wrapper, not the value branch, so
  // collapsing without it would silently drop the model-facing field docs.
  if (typeof schema.description === 'string') merged.description = schema.description;
  return merged;
}

function isObjectSchema(schema: JsonSchema | undefined): schema is JsonSchema {
  return (
    schema !== undefined &&
    typeof schema === 'object' &&
    schema.type === 'object' &&
    typeof schema.properties === 'object'
  );
}

/**
 * Read a tool-variant discriminator, which JSON-Schema generators spell two
 * ways: `const: "name"` (a bare literal) and `enum: ["name"]` (what
 * `z.discriminatedUnion` emits). Accepting only `const` silently rejected every
 * discriminated-union envelope — including the SMS supervisor's — dropping it
 * to the legacy single-schema path whose 27 nullable unions Anthropic refuses.
 */
function discriminatorName(toolField: JsonSchema | undefined): string | null {
  if (!toolField || typeof toolField !== 'object') return null;
  if (typeof toolField.const === 'string') return toolField.const;
  const values = toolField.enum;
  if (Array.isArray(values) && values.length === 1 && typeof values[0] === 'string') {
    return values[0];
  }
  return null;
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
  responseFormat?: ResponseFormat | null,
  anthropic = true
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
    if (discriminatorName(variantProps?.tool as JsonSchema | undefined) === null) return null;
  }

  const tools: Array<Record<string, unknown>> = [];
  for (const variant of anyOf) {
    const variantObj = variant as JsonSchema;
    const variantProps = { ...((variantObj.properties as JsonSchema | undefined) ?? {}) };
    const toolName = discriminatorName(variantProps.tool as JsonSchema) as string;
    const description = (variantObj.description as string | undefined) ?? '';

    delete variantProps.tool;
    const required = (((variantObj.required as unknown[] | undefined) ?? []) as string[]).filter(
      (r) => r !== 'tool'
    );

    // A `{ tool, arguments: {...} }` variant carries its parameters one level
    // down. Native tools take them flat, as every Python tool model does, and
    // the caller replays history with the flat arguments object.
    const nested = variantProps.arguments as JsonSchema | undefined;
    const flattenArguments = Object.keys(variantProps).length === 1 && isObjectSchema(nested);
    const inputSchema: JsonSchema = flattenArguments
      ? { ...nested, properties: nested.properties ?? {}, required: nested.required ?? [] }
      : { type: 'object', properties: variantProps, required };
    if (!flattenArguments && 'additionalProperties' in variantObj) {
      inputSchema.additionalProperties = variantObj.additionalProperties;
    }

    tools.push({
      name: toolName,
      description,
      input_schema: anthropic
        ? relaxNullableUnionsForAnthropic(transformSchemaForAnthropic(inputSchema))
        : inputSchema,
      ...(!anthropic && typeof jsonSchema.strict === 'boolean'
        ? { strict: jsonSchema.strict }
        : {}),
    });
  }

  const responseFieldSchema = properties.response ?? { type: 'string' };
  return { tools, responseFieldSchema };
}

/**
 * Project a tool-envelope `response_model` into native tools for every leg,
 * as agents/providers/rose/client.py does with `direct_auth_tools`. A tool call
 * is then the only legal answer on OpenAI-dialect legs too; plain response
 * models, explicit `tools` and raw `response_format` callers are unchanged.
 */
export function withNativeToolContract(options: CompletionOptions): CompletionOptions {
  if (!options.response_model || options.tools !== undefined) return options;
  const extracted = extractToolsFromResponseFormat(options.response_format, false);
  if (!extracted) return options;
  const anthropicTools = extractToolsFromResponseFormat(options.response_format)?.tools;
  return {
    ...options,
    tools: extracted.tools,
    anthropic_tools: anthropicTools,
    cerebras_tools_source: extracted.tools,
    cerebras_tools: anthropicTools?.map((tool, index) => ({
      ...tool,
      ...(typeof extracted.tools[index].strict === 'boolean'
        ? { strict: extracted.tools[index].strict }
        : {}),
    })),
    tool_choice: options.tool_choice ?? 'any',
    response_format: undefined,
  };
}

/**
 * Qwen's Cerebras chat template allows system messages only as a leading
 * prefix. Chat Generator/Router historically converted TOOL rows to mid-
 * conversation `role: system` (`[Tool Result]\n…`); that 400s with
 * `System message must be at the beginning` and forces the waterfall
 * (web_search lifecycle breach, 2026-09-29). Keep the leading system
 * prefix; coerce every later system turn to user.
 */
export function coerceLeadingOnlySystemMessages(
  messages: CompletionMessage[]
): CompletionMessage[] {
  let seenNonSystem = false;
  return messages.map((message) => {
    if (message.role !== 'system') {
      seenNonSystem = true;
      return message;
    }
    if (!seenNonSystem) return message;
    return { ...message, role: 'user' as const };
  });
}

/**
 * Stamp the OpenAI `type: "function"` discriminator onto every assistant
 * tool_call before an OpenAI-dialect request goes out.
 *
 * Anthropic's transform reads `.function.name` directly and never needed it, so
 * a constructor could omit it and still look correct everywhere we tested.
 * Google validates strictly: without the discriminator it sees an assistant
 * turn with no valid function calls followed by tool results, rejects the whole
 * transcript with 400 "The conversation transcript is malformed", and the pool
 * silently demotes to its weakest leg. Normalizing here means no current or
 * future message constructor can reintroduce that failure.
 */
export function normalizeOpenAiToolCalls(messages: CompletionMessage[]): CompletionMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((toolCall) => {
        // `CompletionMessage` also permits the flat `{id, name, arguments}`
        // shape that the Anthropic and Responses transforms read. OpenAI's
        // chat dialect has no such form, so lift it rather than passing
        // through something even more malformed than the original defect.
        const name = toolCall.function?.name ?? toolCall.name;
        const args = toolCall.function?.arguments ?? toolCall.arguments;
        if (typeof name !== 'string' || name.length === 0) return toolCall;
        // The Responses dialect names this `call_id`; OpenAI's chat dialect
        // requires `id`, and a tool result cannot be matched back to its call
        // without it. Only synthesize the key when an identifier exists.
        const id = toolCall.id ?? toolCall.call_id;
        return {
          ...toolCall,
          ...(id === undefined ? {} : { id }),
          type: 'function' as const,
          function: {
            name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
          },
        };
      }),
    };
  });
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
    // Accept the Anthropic shape and the OpenAI `{function:{parameters}}` shape,
    // like apply_anthropic_tool_config in agents/providers/rose/transforms.py.
    body.tools = tools.flatMap((t) => {
      const tool = canonicalTool(t);
      if (!tool) return [];
      return [
        {
          name: tool.name,
          description: tool.description,
          ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
          input_schema: tool.parameters,
        },
      ];
    });
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
  const name = namedToolChoice(toolChoice);
  if (name !== null) return { type: 'tool', name };
  if (typeof toolChoice === 'object' && toolChoice !== null && 'type' in toolChoice) {
    return toolChoice as Record<string, unknown>;
  }
  return { type: 'any' };
}
