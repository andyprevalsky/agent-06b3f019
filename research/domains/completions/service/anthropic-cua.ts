/**
 * Anthropic Computer Use (CUA) provider.
 *
 * Transforms a unified BrowserUseRequest into Anthropic's computer-tool format,
 * calls the Messages API, and normalizes the tool_use response back into the
 * shared UnifiedAction shape. Used as one of the racers for browser-use
 * completions.
 */

// deno-lint-ignore-file no-explicit-any

import { ANTHROPIC_API_URL, ANTHROPIC_CUA_BETA, ANTHROPIC_CUA_MODEL } from '../config.ts';
import type { BrowserUseRequest, UnifiedAction } from '../types.ts';
import { slog } from '../utils.ts';

// Anthropic CUA system prompt (minimal, role-setting)
const ANTHROPIC_CUA_SYSTEM_PROMPT =
  `You are a computer use assistant that helps automate browser tasks. You have access to a computer tool that allows you to interact with a desktop browser environment.

When given a task:
1. Analyze the current screenshot to understand the page state
2. Reason about what action to take next
3. Use the computer tool to interact with the browser
4. Observe the result and continue until the task is complete

Be precise with your actions. Click accurately on the intended elements. Type text carefully. Scroll when needed to find content.`;

// Transform unified request to Anthropic CUA format
export function transformToAnthropicCUAFormat(req: BrowserUseRequest): {
  messages: any[];
  tools: any[];
} {
  const messages: any[] = [];

  // Build initial user message with task and current screenshot
  const userContent: any[] = [
    { type: 'text', text: `Task: ${req.task}` },
  ];

  // Add current screenshot if available (base64 only - CUA requires base64)
  if (req.browser_state.screenshot && !req.browser_state.screenshot.startsWith('http')) {
    userContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: req.browser_state.screenshot,
      },
    });
  }

  messages.push({ role: 'user', content: userContent });

  // Add action history as assistant/user pairs
  for (let i = 0; i < req.action_history.length; i++) {
    const entry = req.action_history[i];

    // Map our action names to CUA action names
    const cuaAction = mapToCUAAction(entry.action, entry.params, entry.coordinates);

    // Handle actions that don't map to CUA tool calls (like goto/navback)
    if (cuaAction === null) {
      // Add as text-only context (no tool_use)
      const contextText = entry.action === 'goto'
        ? `[Navigated to: ${entry.params?.url || 'unknown URL'}]`
        : entry.action === 'navback'
        ? `[Navigated back to previous page]`
        : `[${entry.action}: ${JSON.stringify(entry.params || {})}]`;

      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: `${entry.thinking || ''}\n\n${contextText}` }],
      });

      // Add observation as user message if screenshot available
      if (entry.screenshot && !entry.screenshot.startsWith('http')) {
        messages.push({
          role: 'user',
          content: [{
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: entry.screenshot,
            },
          }],
        });
      }
      continue; // Skip the tool_use/tool_result pair
    }

    // Assistant message with tool use
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: entry.thinking || `Executing ${entry.action}` },
        {
          type: 'tool_use',
          id: `tool_${i}`,
          name: 'computer',
          input: cuaAction,
        },
      ],
    });

    // User message with tool result
    const toolResultContent: any[] = [];
    if (entry.screenshot) {
      if (entry.screenshot.startsWith('http')) {
        toolResultContent.push({ type: 'text', text: '[Screenshot available via URL]' });
      } else {
        toolResultContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: entry.screenshot,
          },
        });
      }
    } else {
      toolResultContent.push({
        type: 'text',
        text: entry.result.success
          ? 'Action completed successfully'
          : `Error: ${entry.result.error}`,
      });
    }

    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: `tool_${i}`,
        content: toolResultContent,
      }],
    });
  }

  // CUA computer tool definition
  const tools = [{
    type: 'computer_20251124',
    name: 'computer',
    display_width_px: req.browser_state.viewport.width,
    display_height_px: req.browser_state.viewport.height,
    display_number: 1,
  }];

  return { messages, tools };
}

// Map our action names to Anthropic CUA action format
export function mapToCUAAction(
  action: string,
  params?: Record<string, any>,
  coordinates?: { x: number; y: number },
): any {
  switch (action) {
    case 'click':
      return {
        action: 'left_click',
        coordinate: coordinates ? [coordinates.x, coordinates.y] : [0, 0],
      };
    case 'type':
    case 'input_text':
      return { action: 'type', text: params?.text || '' };
    case 'scroll':
    case 'scroll_down':
      return {
        action: 'scroll',
        coordinate: coordinates ? [coordinates.x, coordinates.y] : [640, 400],
        direction: params?.direction || 'down',
        amount: params?.amount || 300,
      };
    case 'scroll_up':
      return {
        action: 'scroll',
        coordinate: coordinates ? [coordinates.x, coordinates.y] : [640, 400],
        direction: 'up',
        amount: params?.amount || 300,
      };
    case 'press_key':
      return { action: 'key', key: params?.key || 'Enter' };
    case 'goto':
    case 'navback':
      // CUA doesn't have navigate actions - return null to add as text context
      return null;
    case 'done':
    case 'attempt_completion':
    case 'send_message_to_user':
      // Non-browser actions - return null to skip in CUA context
      return null;
    default:
      slog('info', `mapToCUAAction: Unknown action "${action}" - treating as text context`);
      return null;
  }
}

// Call Anthropic CUA API
export async function callAnthropicCUA(
  req: BrowserUseRequest,
  apiKey: string,
): Promise<
  {
    response: any;
    ttftMs: number;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }
> {
  const { messages, tools } = transformToAnthropicCUAFormat(req);

  slog('info', 'Anthropic CUA request messages count:', { data: messages.length });

  const requestBody = {
    model: ANTHROPIC_CUA_MODEL,
    max_tokens: 1024,
    system: ANTHROPIC_CUA_SYSTEM_PROMPT,
    tools,
    messages,
  };

  slog('info', 'Anthropic CUA request:', {
    data: JSON.stringify(requestBody, null, 2).slice(0, 1000),
  });

  const startTime = Date.now();

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': ANTHROPIC_CUA_BETA,
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const ttftMs = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    slog('error', 'Anthropic CUA API error:', { data: [response.status, errorText] });
    throw new Error(`Anthropic CUA API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  slog('info', 'Anthropic CUA raw response:', { data: JSON.stringify(data, null, 2) });
  // Extract usage from Anthropic response (uses input_tokens/output_tokens)
  const usage = data.usage
    ? {
      prompt_tokens: data.usage.input_tokens || 0,
      completion_tokens: data.usage.output_tokens || 0,
      total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
    }
    : undefined;
  return { response: data, ttftMs, usage };
}

// Normalize Anthropic CUA response to unified action format
export function normalizeAnthropicCUAResponse(response: any): UnifiedAction {
  slog('info', 'Normalizing Anthropic CUA response');

  const content = response.content || [];

  // Find text and tool_use in content
  const textPart = content.find((c: any) => c.type === 'text');
  const toolUse = content.find((c: any) => c.type === 'tool_use');

  if (!toolUse) {
    return {
      action: 'done',
      thinking: textPart?.text || 'No action returned',
    };
  }

  // Map CUA action back to Python agent expected names
  const cuaAction = toolUse.input?.action || 'unknown';
  let action: string;
  let coordinates: { x: number; y: number } | undefined;
  const normalizedParams: Record<string, any> = {};

  switch (cuaAction) {
    case 'left_click':
    case 'right_click':
    case 'double_click':
      action = 'click';
      if (toolUse.input?.coordinate) {
        coordinates = { x: toolUse.input.coordinate[0], y: toolUse.input.coordinate[1] };
      }
      break;
    case 'type':
      action = 'input_text'; // Map to Python expected name
      if (toolUse.input?.text) normalizedParams.text = toolUse.input.text;
      break;
    case 'scroll':
      action = 'scroll'; // Use unified 'scroll' action
      if (toolUse.input?.direction) {
        normalizedParams.direction = toolUse.input.direction;
        normalizedParams.amount = 300; // Default scroll amount
      }
      if (toolUse.input?.coordinate) {
        coordinates = { x: toolUse.input.coordinate[0], y: toolUse.input.coordinate[1] };
      }
      break;
    case 'key':
      action = 'press_key'; // Map to Python expected name
      if (toolUse.input?.key) normalizedParams.key = toolUse.input.key;
      break;
    case 'wait':
      action = 'wait';
      if (toolUse.input?.duration !== undefined) {
        normalizedParams.time_ms = toolUse.input.duration * 1000;
      }
      break;
    case 'screenshot':
      action = 'screenshot';
      break;
    default:
      throw new Error(
        `normalizeAnthropicCUAResponse: Unmapped CUA action "${cuaAction}" - add to switch statement`,
      );
  }

  return {
    action,
    thinking: textPart?.text,
    coordinates,
    params: normalizedParams,
  };
}
