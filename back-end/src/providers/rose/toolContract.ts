/**
 * Provider-neutral native tool contract.
 * Mirrors agents/providers/rose/client.py (response_model → direct_auth_tools)
 * and waterfall.py / gpt_auth.py (per-dialect tool + tool_choice shapes).
 *
 *   response_model { tool_calls: [ToolA | ToolB] }
 *        │ withNativeToolContract (transforms.ts; one tool per discriminated variant)
 *        ▼
 *   tools [{ name, description, input_schema }] + tool_choice "any"
 *        ├─ Anthropic:   applyAnthropicToolConfig (input_schema, {type:any})
 *        ├─ Responses:   responsesTools / responsesToolChoice ("required")
 *        └─ OpenRouter / Cerebras chat: openAiChatTools / openAiChatToolChoice
 *
 * A tool-envelope response_model means "a tool call is the only legal answer".
 * Sending it as a JSON response_format instead makes every OpenAI-dialect leg
 * answer in content, where Responses models split one turn across commentary
 * and final_answer items and the structured-output reader keeps only one.
 */

type ToolDefinition = Record<string, unknown>;

function functionOf(tool: ToolDefinition): Record<string, unknown> {
  return typeof tool.function === 'object' && tool.function !== null
    ? (tool.function as Record<string, unknown>)
    : tool;
}

function parametersOf(fn: Record<string, unknown>): Record<string, unknown> {
  const candidate = fn.parameters ?? fn.input_schema;
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : {};
}

/** One tool definition in any accepted shape → canonical name/description/schema. */
export function canonicalTool(tool: ToolDefinition): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
} | null {
  const fn = functionOf(tool);
  if (typeof fn.name !== 'string' || fn.name.length === 0) return null;
  return {
    name: fn.name,
    description: typeof fn.description === 'string' ? fn.description : '',
    parameters: parametersOf(fn),
    ...('strict' in fn ? { strict: Boolean(fn.strict) } : {}),
  };
}

/** OpenAI chat-completions dialect (OpenRouter, Cerebras). Mirrors `_openrouter_tools`. */
export function openAiChatTools(tools?: ToolDefinition[] | null): ToolDefinition[] | undefined {
  const out: ToolDefinition[] = [];
  for (const tool of tools ?? []) {
    const canonical = canonicalTool(tool);
    if (!canonical) continue;
    out.push({ type: 'function', function: canonical });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Google AI Studio 400s on the named-function form; degrade it to "required"
 * only there. Mirrors `_openrouter_tool_choice`.
 */
export function openAiChatToolChoice(toolChoice: unknown, model = ''): unknown {
  if (toolChoice === 'any') return 'required';
  const name = namedToolChoice(toolChoice);
  if (name !== null) {
    if (model.toLowerCase().startsWith('google/')) return 'required';
    return { type: 'function', function: { name } };
  }
  return toolChoice;
}

/** OpenAI Responses dialect (gptAuth, OpenAI key, Foundry). Mirrors `_responses_tools`. */
export function responsesTools(tools?: ToolDefinition[] | null): ToolDefinition[] | undefined {
  const out: ToolDefinition[] = [];
  for (const tool of tools ?? []) {
    const canonical = canonicalTool(tool);
    if (!canonical) continue;
    out.push({
      type: 'function',
      name: canonical.name,
      description: canonical.description,
      strict: canonical.strict ?? false,
      parameters: canonical.parameters,
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Mirrors `_responses_tool_choice`. */
export function responsesToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === 'any') return 'required';
  const name = namedToolChoice(toolChoice);
  if (name !== null) return { type: 'function', name };
  return toolChoice ?? 'auto';
}

/** `{name}`, `{type:'tool', name}` or `{function:{name}}` → the tool name. */
export function namedToolChoice(toolChoice: unknown): string | null {
  if (typeof toolChoice !== 'object' || toolChoice === null) return null;
  const choice = toolChoice as Record<string, unknown>;
  if (typeof choice.name === 'string' && choice.name.length > 0) return choice.name;
  const fn = choice.function;
  if (typeof fn === 'object' && fn !== null) {
    const name = (fn as Record<string, unknown>).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return null;
}
