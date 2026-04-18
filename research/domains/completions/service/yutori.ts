/**
 * Yutori N1 provider
 *
 * Transforms a unified BrowserUseRequest into Yutori n1-latest chat-completion
 * format (tool_calls + screenshots per step), calls the Yutori API, and
 * normalizes the response back to a UnifiedAction.
 */

// deno-lint-ignore-file no-explicit-any

import { slog } from '../../../providers/logger.ts';
import { YUTORI_API_URL, YUTORI_MODEL } from '../config.ts';
import { truncateForLogging } from '../utils.ts';
import type { ActionHistoryEntry, BrowserUseRequest, UnifiedAction } from '../types.ts';

// ---------------------------------------------------------------------------
// Request transforms
// ---------------------------------------------------------------------------

// Map our internal action names to n1-latest native tool names
export function mapToYutoriN1ToolName(action: string): string {
  const reverseMap: Record<string, string> = {
    'click': 'left_click',
    'input_text': 'type',
    'press_key': 'key_press',
    'navback': 'go_back',
    'goto': 'goto_url',
    'scroll': 'scroll',
    'wait': 'wait',
    'hover': 'hover',
    'double_click': 'double_click',
    'right_click': 'right_click',
    'drag': 'drag',
    'refresh': 'refresh',
  };
  return reverseMap[action] || action;
}

// Build structured tool_call arguments from an ActionHistoryEntry
export function buildYutoriToolArgs(
  entry: ActionHistoryEntry,
  viewport: { width: number; height: number },
): Record<string, any> {
  const args: Record<string, any> = {};
  const toolName = mapToYutoriN1ToolName(entry.action);

  // Coordinates: convert viewport pixels to 1000x1000 normalized space
  if (entry.coordinates) {
    args.coordinates = [
      Math.round((entry.coordinates.x / viewport.width) * 1000),
      Math.round((entry.coordinates.y / viewport.height) * 1000),
    ];
    slog('info', '[YUTORI] Coordinate transform', {
      data: {
        original: `${entry.coordinates.x},${entry.coordinates.y}`,
        normalized: `${args.coordinates[0]},${args.coordinates[1]}`,
        viewport: `${viewport.width}x${viewport.height}`,
      },
    });
  }

  // Tool-specific arguments
  if (toolName === 'type') {
    if (entry.params?.text) args.text = entry.params.text;
    if (entry.params?.press_enter_after !== undefined) {
      args.press_enter_after = entry.params.press_enter_after;
    }
    if (entry.params?.clear_before_typing !== undefined) {
      args.clear_before_typing = entry.params.clear_before_typing;
    }
  }
  if (toolName === 'key_press' && entry.params?.key) {
    args.key_comb = entry.params.key;
  }
  if (toolName === 'goto_url' && entry.params?.url) {
    args.url = entry.params.url;
  }
  if (toolName === 'scroll') {
    args.direction = entry.params?.direction || 'down';
    // Convert pixel amount to percentage of viewport height for n1-latest
    const pixelAmount = entry.params?.amount || 300;
    args.amount = Math.round((pixelAmount / viewport.height) * 100);
    if (entry.coordinates) {
      args.coordinates = [
        Math.round((entry.coordinates.x / viewport.width) * 1000),
        Math.round((entry.coordinates.y / viewport.height) * 1000),
      ];
    }
  }
  if (toolName === 'drag' && entry.params?.start_coordinates) {
    args.start_coordinates = entry.params.start_coordinates;
  }

  return args;
}

// Transform unified request to Yutori n1-latest format
// n1-latest expects: user message (with screenshot), then alternating assistant (tool_calls) and tool (screenshot) messages
export function transformToYutoriFormat(req: BrowserUseRequest): {
  messages: any[];
} {
  const messages: any[] = [];
  const viewport = req.browser_state.viewport;

  // Determine the first screenshot to include in the user message
  // If there's action history, the first entry's screenshot is the initial state
  // Otherwise use the current browser_state screenshot
  const firstHistoryScreenshot = req.action_history.length > 0
    ? req.action_history[0].screenshot
    : undefined;
  const firstScreenshot = firstHistoryScreenshot || req.browser_state.screenshot;

  // Build user message: task text + initial screenshot
  const userContent: any[] = [
    { type: 'text', text: `Task: ${req.task}` },
  ];

  // Add URL context in the user message
  if (req.browser_state.url) {
    userContent.push({ type: 'text', text: `Current URL: ${req.browser_state.url}` });
  }

  // Add first screenshot to user message (n1-latest requires screenshots in user or tool messages)
  if (firstScreenshot) {
    const imageUrl = firstScreenshot.startsWith('http')
      ? firstScreenshot
      : `data:image/png;base64,${firstScreenshot}`;
    userContent.push({ type: 'image_url', image_url: { url: imageUrl } });
  }

  messages.push({ role: 'user', content: userContent });

  // Process action history as assistant(tool_calls) → tool(screenshot) pairs
  // History entry screenshots represent the state BEFORE that entry's action.
  // So for tool result after entry[i]'s action, we use entry[i+1]'s screenshot
  // (or current browser_state.screenshot for the last entry).
  let lastKnownUrl = req.browser_state.url;

  for (let i = 0; i < req.action_history.length; i++) {
    const entry = req.action_history[i];
    const toolCallId = `call_${i}`;
    const toolName = mapToYutoriN1ToolName(entry.action);
    const toolArgs = buildYutoriToolArgs(entry, viewport);

    // Track URL
    if (entry.action === 'goto' && entry.params?.url) {
      lastKnownUrl = entry.params.url;
    }

    // Assistant message with tool_calls
    messages.push({
      role: 'assistant',
      content: entry.thinking || `Executing ${entry.action}`,
      tool_calls: [{
        id: toolCallId,
        type: 'function',
        function: {
          name: toolName,
          arguments: JSON.stringify(toolArgs),
        },
      }],
    });

    // Tool message with result screenshot
    // Screenshot comes from the NEXT history entry, or current state for the last entry
    const toolContent: any[] = [];

    if (lastKnownUrl) {
      toolContent.push({ type: 'text', text: `Current URL: ${lastKnownUrl}` });
    }

    let resultScreenshot: string | undefined;
    if (i + 1 < req.action_history.length && req.action_history[i + 1].screenshot) {
      resultScreenshot = req.action_history[i + 1].screenshot;
    } else if (i === req.action_history.length - 1) {
      resultScreenshot = req.browser_state.screenshot;
    }

    if (resultScreenshot) {
      const imageUrl = resultScreenshot.startsWith('http')
        ? resultScreenshot
        : `data:image/png;base64,${resultScreenshot}`;
      toolContent.push({ type: 'image_url', image_url: { url: imageUrl } });
    }

    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: toolContent,
    });
  }

  // Tracing: log Yutori messages summary
  slog('info', '[TRACE] Yutori n1-latest messages:', {
    data: {
      total: messages.length,
      assistantCount: messages.filter((m: any) => m.role === 'assistant').length,
      toolCount: messages.filter((m: any) => m.role === 'tool').length,
    },
  });

  return { messages };
}

// ---------------------------------------------------------------------------
// Provider call
// ---------------------------------------------------------------------------

// Call Yutori n1 API
export async function callYutoriLLM(
  req: BrowserUseRequest,
  apiKey: string,
  signal?: AbortSignal,
): Promise<
  {
    response: any;
    ttftMs: number;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }
> {
  const { messages } = transformToYutoriFormat(req);

  slog('info', 'Yutori request messages count:', { data: messages.length });
  slog('info', 'Yutori request messages:', { data: JSON.stringify(messages, null, 2) });

  const requestBody = {
    model: YUTORI_MODEL,
    messages,
    temperature: 0.3,
  };

  slog('info', 'Yutori full request body:', {
    data: JSON.stringify(truncateForLogging(requestBody), null, 2),
  });

  const startTime = Date.now();

  const response = await fetch(YUTORI_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  const ttftMs = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    slog('error', 'Yutori API error:', { data: [response.status, errorText] });
    throw new Error(`Yutori API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  slog('info', 'Yutori raw response:', { data: JSON.stringify(data, null, 2) });

  // Yutori returns 200 with { detail: [...] } or { detail: "string" } for validation errors
  if (data.detail) {
    const msg = Array.isArray(data.detail)
      ? data.detail.map((d: any) => d.msg || d.message || JSON.stringify(d)).join('; ')
      : String(data.detail);
    throw new Error(`Yutori validation error: ${msg}`);
  }

  // Extract usage if available (Yutori API uses OpenAI format)
  const usage = data.usage
    ? {
      prompt_tokens: data.usage.prompt_tokens || 0,
      completion_tokens: data.usage.completion_tokens || 0,
      total_tokens: data.usage.total_tokens || 0,
    }
    : undefined;
  return { response: data, ttftMs, usage };
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

// Normalize Yutori n1-latest response to unified action format
// n1-latest returns actions as native tool_calls, reasoning in content
// Coordinates still in 1000x1000 normalized space
export function normalizeYutoriResponse(
  response: any,
  viewport: { width: number; height: number },
): UnifiedAction {
  slog('info', 'Normalizing Yutori n1-latest response');

  const message = response.choices?.[0]?.message;
  if (!message) {
    throw new Error('normalizeYutoriResponse: No message in Yutori response');
  }

  const thinking = message.content || '';
  const toolCalls = message.tool_calls;

  // If no tool_calls, the model considers the task done
  if (!toolCalls || toolCalls.length === 0) {
    return {
      action: 'done',
      thinking: thinking || 'Task complete',
    };
  }

  // Parse the first tool call
  const firstToolCall = toolCalls[0];
  const toolName = firstToolCall.function?.name;
  let toolArgs: Record<string, any> = {};

  try {
    toolArgs = JSON.parse(firstToolCall.function?.arguments || '{}');
  } catch (_e) {
    slog('error', 'Failed to parse tool_call arguments:', {
      data: firstToolCall.function?.arguments,
    });
    throw new Error(
      `normalizeYutoriResponse: Failed to parse tool_call arguments: ${
        firstToolCall.function?.arguments?.slice(0, 200)
      }`,
    );
  }

  // Convert 1000x1000 coordinates to viewport coordinates
  let coordinates: { x: number; y: number } | undefined;
  if (toolArgs.coordinates && Array.isArray(toolArgs.coordinates)) {
    const [normX, normY] = toolArgs.coordinates;
    coordinates = {
      x: Math.round((normX / 1000) * viewport.width),
      y: Math.round((normY / 1000) * viewport.height),
    };
  }

  // Map n1-latest native tool names to our internal action names
  // n1-latest native tools: left_click, scroll, type, key_press, drag, hover,
  //   double_click, triple_click, right_click, wait, go_back, goto_url, refresh
  const yutoriActionMap: Record<string, string> = {
    'left_click': 'click',
    'type': 'input_text',
    'key_press': 'press_key',
    'go_back': 'navback',
    'goto_url': 'goto',
    'double_click': 'click',
    'triple_click': 'click',
    'right_click': 'click',
  };

  const normalizedAction = yutoriActionMap[toolName] || toolName;

  // Validate action is one we support
  // NOTE: upload_file is NOT included because yutori is a vision model that doesn't understand DOM indices.
  // When yutori tries to return upload_file, we reject it and fall back to browser-use.
  const validYutoriActions = [
    'click',
    'scroll',
    'input_text',
    'press_key',
    'navback',
    'goto',
    'wait',
    'attempt_completion',
    'done',
    'hover',
    'refresh',
  ];
  if (!validYutoriActions.includes(normalizedAction)) {
    throw new Error(
      `normalizeYutoriResponse: Unknown action "${normalizedAction}" (raw tool: "${toolName}") - add to yutoriActionMap or validYutoriActions`,
    );
  }

  // Normalize tool arguments to our internal param format
  const normalizedParams: Record<string, any> = {};

  // Text input
  if (toolArgs.text) normalizedParams.text = toolArgs.text;

  // Navigation URL
  if (toolArgs.url) normalizedParams.url = toolArgs.url;

  // Key presses - n1-latest uses 'key_comb' (Playwright format, e.g., "Control+c")
  if (toolArgs.key_comb) normalizedParams.key = toolArgs.key_comb;

  // Scroll: n1-latest uses percentage-based amount
  if (toolName === 'scroll') {
    normalizedParams.direction = toolArgs.direction || 'down';
    // Convert viewport percentage to pixels
    const percentAmount = toolArgs.amount || 50;
    normalizedParams.amount = Math.round((percentAmount / 100) * viewport.height);
    normalizedParams.amount = Math.min(Math.max(normalizedParams.amount, 100), 2000);
    slog(
      'info',
      `Yutori n1-latest scroll: ${percentAmount}% of ${viewport.height}px → ${normalizedParams.amount}px (direction=${normalizedParams.direction})`,
    );
  }

  // Wait
  if (toolArgs.seconds !== undefined) {
    normalizedParams.time_ms = toolArgs.seconds * 1000;
  }

  // Store normalized coordinates for reference
  if (toolArgs.coordinates) {
    normalizedParams.normalized_coordinates = toolArgs.coordinates;
  }

  return {
    action: normalizedAction,
    thinking,
    coordinates,
    params: normalizedParams,
  };
}
