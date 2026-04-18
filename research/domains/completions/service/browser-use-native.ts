/**
 * Browser-Use native provider
 *
 * Exposes the tool catalog used by the browser-use-style system prompt, the
 * transform that turns a unified BrowserUseRequest into browser-use-compatible
 * OpenAI messages, and the thin wrapper that calls the browser-use hosted LLM.
 */

// deno-lint-ignore-file no-explicit-any

import { BROWSER_USE_API_URL } from '../config.ts';
import { slog, truncateForLogging } from '../utils.ts';
import type { BrowserUseRequest } from '../types.ts';

// ---------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------

// Browser tool definitions - using Python agent naming conventions
// Each tool has: name, description, params with types and descriptions
export const BROWSER_USE_TOOLS: Record<
  string,
  {
    description: string;
    params: Record<string, { type: string; description: string; required?: boolean }>;
  }
> = {
  // === NAVIGATION ===
  goto: {
    description: 'Navigate to a URL',
    params: {
      url: { type: 'string', description: 'URL to navigate to', required: true },
    },
  },
  navback: {
    description: 'Go back to the previous page in browser history',
    params: {},
  },

  // === WAITING ===
  wait: {
    description: 'Wait for x seconds (capped at 30s)',
    params: {
      seconds: { type: 'integer', description: 'Seconds to wait (default: 3)' },
    },
  },

  // === CLICKING ===
  click: {
    description: 'Click element by index',
    params: {
      index: { type: 'integer', description: 'Element index from browser_state', required: true },
    },
  },
  // Coordinate-based clicking (for vision models)
  click_coordinates: {
    description: 'Click at specific coordinates (for vision models when index unavailable)',
    params: {
      x: { type: 'integer', description: 'X coordinate', required: true },
      y: { type: 'integer', description: 'Y coordinate', required: true },
    },
  },

  // === TEXT INPUT ===
  input_text: {
    description: 'Input text into element by index',
    params: {
      index: { type: 'integer', description: 'Element index from browser_state', required: true },
      text: { type: 'string', description: 'Text to input', required: true },
      clear: { type: 'boolean', description: 'Clear field before typing (default: true)' },
    },
  },

  // === KEYBOARD ===
  press_key: {
    description: 'Send keyboard keys or shortcuts',
    params: {
      keys: {
        type: 'string',
        description: 'Keys (Escape, Enter, PageDown) or shortcuts (Control+o)',
        required: true,
      },
    },
  },

  // === SCROLLING ===
  scroll: {
    description:
      'Scroll by pages. Use down=True for scroll down, down=False for scroll up. Use index for scroll containers.',
    params: {
      down: {
        type: 'boolean',
        description: 'True=scroll down, False=scroll up (default: true)',
        required: true,
      },
      pages: {
        type: 'number',
        description: '0.5=half page, 1=full page, 10=to bottom/top (default: 1.0)',
      },
      index: {
        type: 'integer',
        description: 'Optional element index to scroll within specific container',
      },
    },
  },
  find_text: {
    description: 'Scroll to specific text on the page',
    params: {
      text: { type: 'string', description: 'Text to find and scroll to', required: true },
    },
  },

  // === EXTRACTION ===
  extract: {
    description:
      'LLM extracts structured data from page markdown. Use when on right page and know what to extract.',
    params: {
      query: { type: 'string', description: 'What to extract from the page', required: true },
      extract_links: { type: 'boolean', description: 'Set True to extract URLs (default: false)' },
    },
  },
  // === DROPDOWNS ===
  dropdown_options: {
    description: 'Get all options from a native dropdown or ARIA menu',
    params: {
      index: { type: 'integer', description: 'Element index of the dropdown', required: true },
    },
  },
  select_dropdown: {
    description: 'Set the option of a <select> element',
    params: {
      index: { type: 'integer', description: 'Element index of the dropdown', required: true },
      text: { type: 'string', description: 'Exact text of the option to select', required: true },
    },
  },

  // === JAVASCRIPT ===
  evaluate: {
    description:
      'Execute browser JavaScript. Wrap in IIFE with try-catch. Use for hover, drag, custom selectors, shadow DOM.',
    params: {
      code: { type: 'string', description: 'JavaScript code to execute', required: true },
    },
  },

  // === TAB MANAGEMENT ===
  switch_tab: {
    description:
      'Switch to another open tab by tab_id (last 4 chars of target_id shown in browser state)',
    params: {
      tab_id: { type: 'string', description: '4-char tab ID', required: true },
    },
  },
  close_tab: {
    description: 'Close a tab by tab_id. Closes current tab if omitted.',
    params: {
      tab_id: {
        type: 'string',
        description: '4-char tab ID (optional, closes current if omitted)',
      },
    },
  },
  open_new_tab: {
    description: 'Open a new browser tab, optionally navigating to a URL',
    params: {
      url: { type: 'string', description: 'URL to open in new tab (defaults to about:blank)' },
    },
  },

  // === COMPLETION ===
  done: {
    description: 'Complete the task and provide final result',
    params: {
      text: {
        type: 'string',
        description: 'Final result message in the format user requested',
        required: true,
      },
      success: {
        type: 'boolean',
        description: 'True if task completed successfully (default: true)',
      },
    },
  },
  attempt_completion: {
    description: 'Attempt to complete the task with a result message',
    params: {
      result: { type: 'string', description: 'The result/answer for the user', required: true },
    },
  },
  send_message_to_user: {
    description: 'Send a message to the user (for updates or asking for help)',
    params: {
      message: { type: 'string', description: 'Message content', required: true },
    },
  },
  screenshot: {
    description:
      'Take a full-page screenshot of the current page (captures entire page, not just viewport). The screenshot is saved and returned to the orchestrating agent. Only call once per page — one call captures everything.',
    params: {},
  },
};

// ---------------------------------------------------------------------------
// Prompt generation
// ---------------------------------------------------------------------------

// Generate tool description string filtered by available_actions
export function generateToolDescriptions(availableActions: string[]): string {
  const descriptions: string[] = [];

  for (const actionName of availableActions) {
    const tool = BROWSER_USE_TOOLS[actionName];
    if (!tool) continue;

    // Build params string like: (param1=type (desc), param2=type)
    const paramParts: string[] = [];
    for (const [paramName, paramInfo] of Object.entries(tool.params)) {
      let part = `${paramName}=${paramInfo.type}`;
      if (paramInfo.description) {
        part += ` (${paramInfo.description})`;
      }
      paramParts.push(part);
    }

    const paramsStr = paramParts.length > 0 ? ` (${paramParts.join(', ')})` : '';
    descriptions.push(`- ${actionName}: ${tool.description}${paramsStr}`);
  }

  return descriptions.join('\n');
}

// Full browser-use system prompt (based on their system_prompt_browser_use.md)
export function buildBrowserUseSystemPrompt(availableActions: string[]): string {
  const toolDescriptions = generateToolDescriptions(availableActions);

  return `You are a browser-use agent operating in thinking mode. You automate browser tasks by outputting structured JSON actions.

<intro>
You excel at:
1. Navigating complex websites and extracting precise information
2. Automating form submissions and interactive web actions
3. Operating effectively in an agent loop
4. Efficiently performing diverse web tasks
</intro>

<input>
At every step, your input will consist of:
1. Current URL, viewport size, scroll position
2. Interactive elements indexed for actions (format: [index]<type>text</type>)
3. Previous action results and history
4. Optional screenshot of the browser
</input>

<browser_rules>
- Only interact with elements that have a numeric [index] assigned
- Only use indexes that are explicitly provided in the current state
- If expected elements are missing, try scrolling or waiting
- By default, only elements in the visible viewport are listed - use scroll if content is offscreen
- You can scroll by pages using the pages parameter (0.5 for half page, 2.0 for two pages)
- If you fill an input field and action is interrupted, suggestions may have appeared
</browser_rules>

<available_actions>
${toolDescriptions}
</available_actions>

<output>
You must ALWAYS respond with valid JSON in this exact format:
{
  "thinking": "A structured reasoning block analyzing: current page state, what was attempted, what worked/failed, and strategic planning for next steps.",
  "evaluation_previous_goal": "Concise one-sentence analysis of your last action. Clearly state success, failure, or uncertain.",
  "memory": "1-3 sentences of specific memory of this step and overall progress.",
  "next_goal": "State the next immediate goal and action to achieve it.",
  "action": [{"action_name": {...params...}}]
}
Action list should NEVER be empty.
</output>`;
}

// ---------------------------------------------------------------------------
// Message transform + provider call
// ---------------------------------------------------------------------------

// Build browser-use format messages (used for browser-use LLM and generic LLMs)
// Supports vision by including screenshot in multimodal user message
// Set includeScreenshot=false for DOM-only models to reduce tokens and latency
export function transformToBrowserUseFormat(
  req: BrowserUseRequest,
  options?: { includeScreenshot?: boolean },
): {
  messages: any[];
} {
  const includeScreenshot = options?.includeScreenshot ?? true;
  const bs = req.browser_state;

  // Build page stats summary (like browser-use's AgentMessagePrompt)
  let statsText = '';
  if (bs.page_stats) {
    const ps = bs.page_stats;
    statsText = `<page_stats>${ps.links} links, ${ps.interactive} interactive, `;
    statsText += `${ps.iframes} iframes, ${ps.scroll_containers} scroll containers`;
    if (ps.images > 0) statsText += `, ${ps.images} images`;
    statsText += `, ${ps.total_elements} total elements</page_stats>\n`;
  }

  // Build scroll context
  let scrollText = `Scroll: (${bs.scroll_position.x}, ${bs.scroll_position.y})`;
  if (bs.scroll_position.pages_above !== undefined) {
    scrollText +=
      ` | ${bs.scroll_position.pages_above} pages above, ${bs.scroll_position.pages_below} pages below`;
  }

  // Build tabs info
  let tabsText = '';
  if (bs.tabs && bs.tabs.length > 0) {
    tabsText = '\nOpen Tabs:\n';
    for (const tab of bs.tabs) {
      tabsText += `  Tab ${tab.id}: ${tab.url} - ${tab.title}\n`;
    }
  }

  // Build recent events
  let eventsText = '';
  if (bs.recent_events && bs.recent_events.length > 0) {
    eventsText = `\nRecent Events: ${bs.recent_events.join(', ')}\n`;
  }

  // Build closed popups
  let popupsText = '';
  if (bs.closed_popups && bs.closed_popups.length > 0) {
    popupsText = '\nAuto-closed dialogs:\n';
    for (const popup of bs.closed_popups) {
      popupsText += `  - ${popup}\n`;
    }
  }

  // Build action history description
  let historyDesc = '';
  if (req.action_history.length > 0) {
    historyDesc = '\n\nPrevious Actions:\n';
    for (const entry of req.action_history) {
      historyDesc += `Step ${entry.step}: `;
      if (entry.thinking) historyDesc += `[Thinking: ${entry.thinking}] `;
      historyDesc += `${entry.action}`;
      if (entry.index !== undefined) historyDesc += ` (index: ${entry.index})`;
      if (entry.result.success) {
        historyDesc += ' ✓';
      } else {
        historyDesc += ` ✗ Error: ${entry.result.error || 'Unknown error'}`;
      }
      historyDesc += '\n';
    }
  }

  // Build text content
  const textContent = `Task: ${req.task}

${statsText}Current URL: ${bs.url}${bs.title ? ` - ${bs.title}` : ''}
Viewport: ${bs.viewport.width}x${bs.viewport.height}
${scrollText}${tabsText}${eventsText}${popupsText}
Interactive elements:
${bs.dom_tree}${historyDesc}`;

  // Build user message - multimodal if screenshot available AND requested
  let userContent: any;
  if (bs.screenshot && includeScreenshot) {
    // Multimodal message with text + image
    const imageUrl = bs.screenshot.startsWith('http')
      ? bs.screenshot
      : `data:image/png;base64,${bs.screenshot}`;

    userContent = [
      { type: 'text', text: textContent },
      { type: 'image_url', image_url: { url: imageUrl } },
    ];
  } else {
    // Text-only message (for DOM-only models or when no screenshot)
    userContent = textContent;
  }

  // Build dynamic system prompt based on available actions
  const systemPrompt = buildBrowserUseSystemPrompt(req.available_actions);

  const messages = [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: userContent,
    },
  ];

  return { messages };
}

// Call browser-use hosted LLM
export async function callBrowserUseLLM(
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
  const { messages } = transformToBrowserUseFormat(req);

  slog('info', 'browser-use request messages:', { data: JSON.stringify(messages, null, 2) });

  const startTime = Date.now();

  // Don't pass output_format - let browser-use API use its internal format
  const requestBody = {
    model: 'bu-1-0',
    messages,
    request_type: 'browser_agent',
    fast: false,
  };

  slog('info', 'browser-use full request:', {
    data: JSON.stringify(truncateForLogging(requestBody), null, 2),
  });

  const response = await fetch(BROWSER_USE_API_URL, {
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
    slog('error', 'browser-use API error:', { data: [response.status, errorText] });
    throw new Error(`browser-use API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  slog('info', 'browser-use raw response:', { data: JSON.stringify(data, null, 2) });
  // Extract usage if available (browser-use API uses OpenAI format)
  const usage = data.usage
    ? {
      prompt_tokens: data.usage.prompt_tokens || 0,
      completion_tokens: data.usage.completion_tokens || 0,
      total_tokens: data.usage.total_tokens || 0,
    }
    : undefined;
  return { response: data, ttftMs, usage };
}
