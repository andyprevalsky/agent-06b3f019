/**
 * Anthropic helpers.
 *
 * Everything needed to adapt OpenAI-style completion requests to the Anthropic
 * Messages API: model detection, content/message transforms (image_url -> image,
 * tool_calls -> tool_use, tool -> tool_result), schema sanitization, tool
 * extraction from structured-output schemas, and response reconstruction back
 * into the agent's expected JSON envelope.
 *
 * Consumed by the racing/streaming services when routing to Claude models or
 * using user-provided Claude OAuth tokens.
 */

// deno-lint-ignore-file no-explicit-any

// Check if a model is an Anthropic Claude model
export function isAnthropicModel(model: string): boolean {
  return model.toLowerCase().includes('anthropic/') || model.toLowerCase().includes('claude');
}

/**
 * Count tool types in a response_format schema.
 * Anthropic limits anyOf branches to 8 (for tool unions). Our schema has
 * tool_calls.items.anyOf = [tool1, tool2, ...] OR uses $defs with anyOf $refs.
 */
export function countToolTypes(responseFormat: any): number {
  if (!responseFormat?.json_schema?.schema) return 0;

  const schema = responseFormat.json_schema.schema;

  // Check tool_calls.items.anyOf directly
  const toolCallsItems = schema.properties?.tool_calls?.items;
  if (toolCallsItems?.anyOf) {
    return toolCallsItems.anyOf.length;
  }

  // Check $defs for tool definitions (our schema uses $defs)
  if (schema.$defs) {
    // Count definitions that look like tool schemas (have 'tool' property with const)
    let toolCount = 0;
    for (const def of Object.values(schema.$defs) as any[]) {
      if (def.properties?.tool?.const) {
        toolCount++;
      }
    }
    if (toolCount > 0) return toolCount;
  }

  return 0;
}

/**
 * Transform OpenAI content block to Anthropic format.
 * - image_url with data URI -> image with base64 source
 * - file blocks (PDF) -> document with base64 source
 * - text blocks pass through
 */
export function transformContentBlockForAnthropic(block: any): any {
  if (block.type === 'image_url' && block.image_url?.url) {
    const url = block.image_url.url;
    // Check if it's a data URI (base64)
    if (url.startsWith('data:')) {
      // Parse data URI: data:image/jpeg;base64,/9j/...
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        const [, mediaType, data] = match;
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: data,
          },
        };
      }
    }
    // For URL-based images, keep as-is (Anthropic supports URL images too)
    return {
      type: 'image',
      source: {
        type: 'url',
        url: url,
      },
    };
  }

  if (block.type === 'file' && block.file?.file_data) {
    // Transform file block (PDF) to Anthropic document format
    const fileData = block.file.file_data;
    if (fileData.startsWith('data:')) {
      const match = fileData.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        const [, mediaType, data] = match;
        return {
          type: 'document',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: data,
          },
        };
      }
    }
  }

  // Pass through text and other blocks unchanged
  return block;
}

/**
 * Transform OpenAI messages format to Anthropic format.
 * - System messages go to top-level 'system' param
 * - Remove trailing assistant messages (prefill not allowed with output_format)
 * - Convert image_url blocks to Anthropic image format
 * - Convert file blocks (PDF) to Anthropic document format
 */
export function transformMessagesForAnthropic(
  messages: any[],
): { system: string; messages: any[] } {
  const systemParts: string[] = [];
  const anthropicMessages: any[] = [];

  for (const [idx, msg] of messages.entries()) {
    if (msg.role === 'system') {
      systemParts.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
      continue;
    }

    // OpenAI-style assistant tool_calls -> Anthropic assistant tool_use blocks
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const contentBlocks: any[] = [];

      // Preserve assistant text/content if present
      if (Array.isArray(msg.content)) {
        contentBlocks.push(...msg.content.map(transformContentBlockForAnthropic));
      } else if (typeof msg.content === 'string') {
        if (msg.content.length > 0) {
          contentBlocks.push({ type: 'text', text: msg.content });
        }
      } else if (msg.content !== undefined && msg.content !== null) {
        contentBlocks.push({ type: 'text', text: JSON.stringify(msg.content) });
      }

      for (const [toolIdx, tc] of msg.tool_calls.entries()) {
        const toolCallId = tc?.id;
        const toolName = tc?.function?.name;
        const rawArgs = tc?.function?.arguments;

        if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
          throw new Error(
            `transformMessagesForAnthropic: assistant tool_call missing id (message_index=${idx}, tool_index=${toolIdx})`,
          );
        }
        if (typeof toolName !== 'string' || toolName.length === 0) {
          throw new Error(
            `transformMessagesForAnthropic: assistant tool_call missing function.name (message_index=${idx}, tool_index=${toolIdx})`,
          );
        }

        let parsedArgs: any = {};
        if (rawArgs === undefined || rawArgs === null || rawArgs === '') {
          parsedArgs = {};
        } else if (typeof rawArgs === 'string') {
          try {
            parsedArgs = JSON.parse(rawArgs);
          } catch {
            const preview = rawArgs.slice(0, 200);
            throw new Error(
              `transformMessagesForAnthropic: invalid tool_call arguments JSON ` +
                `(message_index=${idx}, tool_index=${toolIdx}, tool_name=${toolName}, preview=${preview})`,
            );
          }
        } else if (typeof rawArgs === 'object') {
          parsedArgs = rawArgs;
        } else {
          throw new Error(
            `transformMessagesForAnthropic: unsupported tool_call arguments type ` +
              `(message_index=${idx}, tool_index=${toolIdx}, tool_name=${toolName}, type=${typeof rawArgs})`,
          );
        }

        if (parsedArgs === null || Array.isArray(parsedArgs) || typeof parsedArgs !== 'object') {
          throw new Error(
            `transformMessagesForAnthropic: tool_call arguments must decode to an object ` +
              `(message_index=${idx}, tool_index=${toolIdx}, tool_name=${toolName})`,
          );
        }

        contentBlocks.push({
          type: 'tool_use',
          id: toolCallId,
          name: toolName,
          input: parsedArgs,
        });
      }

      anthropicMessages.push({
        role: 'assistant',
        content: contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: '' }],
      });
      continue;
    }

    // OpenAI-style tool message -> Anthropic user/tool_result
    if (msg.role === 'tool') {
      const toolCallId = msg.tool_call_id;
      if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
        throw new Error(
          `transformMessagesForAnthropic: tool message missing tool_call_id (message_index=${idx})`,
        );
      }

      let toolResultContent: any;
      if (Array.isArray(msg.content)) {
        toolResultContent = msg.content.map(transformContentBlockForAnthropic);
      } else if (typeof msg.content === 'string') {
        toolResultContent = msg.content;
      } else if (msg.content === undefined || msg.content === null) {
        toolResultContent = '';
      } else {
        toolResultContent = JSON.stringify(msg.content);
      }

      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolCallId,
          content: toolResultContent,
        }],
      });
      continue;
    }

    // Transform content blocks if content is an array
    if (Array.isArray(msg.content)) {
      const transformedContent = msg.content.map(transformContentBlockForAnthropic);
      anthropicMessages.push({ ...msg, content: transformedContent });
    } else {
      anthropicMessages.push(msg);
    }
  }

  // Bundle consecutive tool_result user messages into one
  // Anthropic docs show all tool results from a single turn in a single user message.
  // This improves semantic clarity, token efficiency, and API compliance.
  const bundled: any[] = [];
  for (const msg of anthropicMessages) {
    const prev = bundled[bundled.length - 1];
    const prevIsToolResult = prev?.role === 'user' &&
      Array.isArray(prev.content) &&
      prev.content.length > 0 &&
      prev.content.every((b: any) => b.type === 'tool_result');
    const currIsToolResult = msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.length > 0 &&
      msg.content.every((b: any) => b.type === 'tool_result');

    if (prevIsToolResult && currIsToolResult) {
      prev.content.push(...msg.content);
    } else {
      bundled.push(msg);
    }
  }

  // Remove trailing assistant messages (not allowed with output_format)
  while (bundled.length > 0 && bundled[bundled.length - 1].role === 'assistant') {
    bundled.pop();
  }

  return {
    system: systemParts.join('\n\n'),
    messages: bundled,
  };
}

/**
 * Strip unsupported constraints from schema for Anthropic.
 * Anthropic doesn't support: minimum, maximum, minLength, maxLength, etc.
 */
export function transformSchemaForAnthropic(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;

  const transformed = { ...schema };

  // Remove unsupported constraints
  const unsupported = [
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'multipleOf',
    'minItems',
    'maxItems',
  ];
  for (const key of unsupported) {
    delete transformed[key];
  }

  // Anthropic doesn't support additionalProperties as a schema object (e.g. Dict[str, str]).
  // Convert to additionalProperties: false so the request doesn't get rejected.
  if (
    transformed.type === 'object' && typeof transformed.additionalProperties === 'object' &&
    transformed.additionalProperties !== null
  ) {
    transformed.additionalProperties = false;
  }

  // Recurse into properties
  if (transformed.properties) {
    transformed.properties = { ...transformed.properties };
    for (const key of Object.keys(transformed.properties)) {
      transformed.properties[key] = transformSchemaForAnthropic(transformed.properties[key]);
    }
  }

  // Recurse into array items
  if (transformed.items) {
    transformed.items = transformSchemaForAnthropic(transformed.items);
  }

  // Recurse into $defs
  if (transformed.$defs) {
    transformed.$defs = { ...transformed.$defs };
    for (const key of Object.keys(transformed.$defs)) {
      transformed.$defs[key] = transformSchemaForAnthropic(transformed.$defs[key]);
    }
  }

  // Recurse into anyOf/oneOf/allOf
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (transformed[keyword] && Array.isArray(transformed[keyword])) {
      transformed[keyword] = transformed[keyword].map((item: any) =>
        transformSchemaForAnthropic(item)
      );
    }
  }

  return transformed;
}

/**
 * Extract tool definitions from a response_format JSON schema that embeds tools
 * as anyOf variants inside a tool_calls array. Converts them to native Anthropic
 * tool format so we avoid the "compiled grammar is too large" error.
 *
 * Returns null if the schema doesn't match the expected pattern.
 */
function _extractToolsFromResponseFormat(responseFormat: any): {
  tools: Array<{ name: string; description: string; input_schema: any }>;
  responseFieldSchema: any;
} | null {
  const schema = responseFormat?.json_schema?.schema;
  if (!schema?.properties?.tool_calls?.items?.anyOf) return null;

  const anyOfVariants: any[] = schema.properties.tool_calls.items.anyOf;
  // Each variant must have properties.tool.const to be a valid tool discriminator
  if (!anyOfVariants.every((v: any) => v.properties?.tool?.const)) return null;

  const tools: Array<{ name: string; description: string; input_schema: any }> = [];

  for (const variant of anyOfVariants) {
    const toolName: string = variant.properties.tool.const;
    const description: string = variant.description || '';

    // Clone properties, remove the "tool" discriminator field
    const inputProperties: any = { ...variant.properties };
    delete inputProperties.tool;

    // Build required array without "tool"
    const required = (variant.required || []).filter((r: string) => r !== 'tool');

    const inputSchema: any = {
      type: 'object',
      properties: inputProperties,
      required,
    };

    // Preserve additionalProperties if present
    if (variant.additionalProperties !== undefined) {
      inputSchema.additionalProperties = variant.additionalProperties;
    }

    tools.push({
      name: toolName,
      description,
      input_schema: transformSchemaForAnthropic(inputSchema),
    });
  }

  // Extract the response field schema for reference
  const responseFieldSchema = schema.properties.response || { type: 'string' };

  return { tools, responseFieldSchema };
}

/**
 * Reconstruct the JSON response the agent expects from Anthropic's native
 * text + tool_use content blocks.
 *
 * Agent expects:
 *   {"reasoning": "", "response": "<text>", "tool_calls": [{"tool": "<name>", ...params}]}
 */
export function reconstructAgentResponse(
  textContent: string,
  toolUseBlocks: Array<{ name: string; input: any }>,
): string {
  const toolCalls = toolUseBlocks.map((t) => ({
    tool: t.name,
    ...t.input,
  }));
  return JSON.stringify({ reasoning: '', response: textContent, tool_calls: toolCalls });
}

/**
 * Apply tool config or structured output to an Anthropic request body.
 * Shared by both streaming and non-streaming claude_token paths.
 *
 * Priority: native tools (from response_format) > explicit tools > structured output schema
 *
 * Returns true if native tool mode is active (response needs reconstruction).
 */
export function applyAnthropicToolConfig(
  anthropicBody: any,
  responseFormat: any,
  isClaudeAuth: boolean,
  explicitTools?: any[],
  explicitToolChoice?: any,
): boolean {
  if (explicitTools?.length) {
    anthropicBody.tools = explicitTools.map((t: any) => ({
      name: t.function?.name ?? t.name,
      description: t.function?.description ?? t.description,
      input_schema: t.function?.parameters ?? t.input_schema,
    }));
    if (explicitToolChoice) {
      if (explicitToolChoice === 'auto') anthropicBody.tool_choice = { type: 'auto' };
      else if (explicitToolChoice === 'required' || explicitToolChoice === 'any') {
        anthropicBody.tool_choice = { type: 'any' };
      } else if (explicitToolChoice?.function?.name) {
        anthropicBody.tool_choice = { type: 'tool', name: explicitToolChoice.function.name };
      }
    }
    return false;
  }

  if (responseFormat?.json_schema?.schema) {
    // For claudeAuth, try native tool extraction first to avoid "compiled grammar too large"
    if (isClaudeAuth) {
      const extracted = _extractToolsFromResponseFormat(responseFormat);
      if (extracted) {
        anthropicBody.tools = extracted.tools;
        anthropicBody.tool_choice = { type: 'any' };
        // Remove structured output — we'll reconstruct the JSON envelope from tool_use blocks
        delete anthropicBody.output_config;
        delete anthropicBody.output_format;
        return true; // native tool mode
      }
    }

    const transformedSchema = transformSchemaForAnthropic(responseFormat.json_schema.schema);
    if (isClaudeAuth) {
      anthropicBody.output_config = {
        format: { type: 'json_schema', schema: transformedSchema },
      };
    } else {
      anthropicBody.output_format = {
        type: 'json_schema',
        schema: transformedSchema,
      };
    }
  }

  return false;
}
