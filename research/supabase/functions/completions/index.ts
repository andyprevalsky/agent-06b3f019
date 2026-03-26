import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@~2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key, x-request-id, x-agent-id, x-call-site",
};

// Structured logging helper
function slog(level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component: 'Rose',
    message,
    ...extra,
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

// ============================================
// ROSE COMPLETION CHUNK — canonical SSE shape
// All streaming paths (Anthropic direct, OpenRouter passthrough,
// claude-auth) MUST produce chunks conforming to this interface.
// Consumers: agents/helpers/llm.py, back-end/src/lib/chat/supabaseCompletions.ts
// ============================================
interface RoseCompletionChunk {
  choices: Array<{
    index: number;
    delta: {
      content?: string;    // Text or JSON tokens
      reasoning?: string;  // Thinking/reasoning from reasoning-capable models
      role?: string;       // Only on first chunk (OpenRouter includes this)
    };
    finish_reason?: string | null;  // 'stop' on final content chunk
  }>;
  // Rose metadata — always present on every chunk
  requested_model: string;
  actual_model: string;
  pool_name: string;
  pool_size: number;
  // Set when a claude_token call failed and we fell back to racing.
  // Values: "auth_error" (401/403), "rate_limit" (429), "server_error" (5xx/network), "stall" (20s timeout)
  claude_token_error?: string;
  // Token usage — only on the final chunk (when stream_options.include_usage=true)
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// ============================================
// LATENCY RACING CONFIGURATION
// ============================================
const MAX_LATENCY_CAP_MS = 3000;    // Models with TTFT > 3s excluded entirely
const MAX_DELAY_CAP_MS = 1000;      // Max delay to equalize latencies (faster models excluded if need more delay)
const LATENCY_CACHE_TTL_MS = 60000; // 1 minute cache TTL
const TRIO_SIZE = 3;                // Race 3 models per request

// Browser-use completion racing (higher caps since these are full responses, not TTFT)
const BU_MAX_LATENCY_CAP_MS = 30000;   // 30s hard cap (browser-use models take 2-15s)
const BU_MAX_DELAY_CAP_MS = 5000;      // 5s max delay between fastest/slowest
const BU_DEFAULT_LATENCY_MS = 5000;    // Default when no cache
const BU_RACE_TIMEOUT_MS = 45000;      // 45s overall race timeout

// Model pools for Rose variants - sync with backend/src/routes/rose.ts
const MODEL_POOLS: Record<string, string[]> = {
  'rose-1-lite': [
    'google/gemini-3-flash-preview',
    'moonshotai/kimi-k2.5',
  ],
  'rose-1-ultra': [
    // 'anthropic/claude-opus-4.6',  // Disabled: Anthropic API credits depleted
    'openai/gpt-5.2',
    'google/gemini-3-pro-preview',
    'moonshotai/kimi-k2.5'
  ],
  // Browser automation pool - completion-based trio racing
  'rose-1-browser-use': [
    'browser-use',                   // Index 0 - bu-1-0 (their hosted LLM)
    'yutori/n1',                     // Index 1 - Vision-only, coordinate output
    'openai/gpt-5.2',               // Index 2 - DOM-only (via OpenRouter)
    // 'anthropic/claude-opus-4.6',    // Index 3 - DOM-only (direct Anthropic API) — Disabled: Anthropic API credits depleted
  ]
};

// Pools that use waterfall routing (sequential fallback) instead of trio racing
const WATERFALL_POOLS = new Set(['rose-1-lite']);

// Waterfall config
const WATERFALL_TIMEOUT_MS = 60000;  // 60s per-model timeout

// ============================================
// FILE SIZE CAPABILITY FILTERING
// ============================================
// Models that don't support vision/images at all
const NO_VISION_MODELS = new Set([
  'moonshotai/kimi-k2-0905',
  'moonshotai/kimi-k2-thinking',
]);

// Models with 5MB image size limit (Anthropic)
const MAX_5MB_MODELS = new Set([
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4.5',
]);

const FIVE_MB = 5 * 1024 * 1024;

/**
 * Detect the maximum base64 file size in request messages.
 * Returns 0 if no base64 files are found.
 */
function getMaxBase64FileSizeBytes(messages: any[]): number {
  let maxSize = 0;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'image_url' && block.image_url?.url?.startsWith('data:')) {
          // Extract base64 portion after "data:mime;base64,"
          const base64 = block.image_url.url.split(',')[1];
          if (base64) {
            // base64 to bytes: each 4 base64 chars = 3 bytes
            const sizeBytes = Math.ceil(base64.length * 0.75);
            maxSize = Math.max(maxSize, sizeBytes);
          }
        }
      }
    }
  }
  return maxSize;
}

/**
 * Filter models based on file size capability.
 * - No files: route to all models
 * - Files <= 5MB: exclude Kimi (no vision)
 * - Files > 5MB: exclude Kimi AND Anthropic
 */
function filterPoolByFileSize(pool: string[], maxFileSizeBytes: number): string[] {
  if (maxFileSizeBytes === 0) return pool; // No files, all models eligible

  // Any file -> exclude models without vision
  let filtered = pool.filter(m => !NO_VISION_MODELS.has(m));

  if (maxFileSizeBytes > FIVE_MB) {
    // Large files -> also exclude Anthropic (5MB limit)
    filtered = filtered.filter(m => !MAX_5MB_MODELS.has(m));
  }

  const excluded = pool.filter(m => !filtered.includes(m));
  if (excluded.length > 0) {
    slog('info', `File size ${(maxFileSizeBytes / 1024 / 1024).toFixed(2)}MB, excluded models: ${excluded.join(', ')}`);
  }

  return filtered;
}

// Browser-use API configuration
const BROWSER_USE_API_URL = 'https://llm.api.browser-use.com/v1/chat/completions';

// Yutori n1 API configuration
const YUTORI_API_URL = 'https://api.yutori.com/v1/chat/completions';
const YUTORI_MODEL = 'n1-latest';

// Anthropic CUA (Computer Use) API configuration
const ANTHROPIC_CUA_MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_CUA_BETA = 'computer-use-2025-11-24';

// Helper to truncate base64 data in objects for logging
function truncateForLogging(obj: any, maxBase64Length = 100): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // Check if it's a base64 data URI or long base64 string
    if (obj.startsWith('data:image/') || (obj.length > 500 && /^[A-Za-z0-9+/=]+$/.test(obj.slice(0, 100)))) {
      return `[BASE64_TRUNCATED:${obj.length} chars]`;
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => truncateForLogging(item, maxBase64Length));
  }
  if (typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      // Special handling for known screenshot fields
      if ((key === 'screenshot' || key === 'url' || key === 'image_url') && typeof value === 'string') {
        if (value.startsWith('data:image/') || (value.length > 500 && /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 100)))) {
          result[key] = `[BASE64_TRUNCATED:${value.length} chars]`;
          continue;
        }
      }
      result[key] = truncateForLogging(value, maxBase64Length);
    }
    return result;
  }
  return obj;
}


function escapeForJsonString(content: string): string {
  return content
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// Returns:
// - true: stream appears to be JSON (raw or fenced)
// - false: definitely plain text
// - null: undecided, need more bytes
function detectJsonTextStart(content: string): boolean | null {
  if (!content) return null;

  const trimmed = content.trimStart();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) return true;

  if (trimmed.startsWith('```')) {
    const nlMatch = trimmed.match(/^```[^\r\n]*\r?\n([\s\S]*)$/);
    if (!nlMatch) {
      // Have opening fence but not the rest yet.
      return null;
    }
    const afterFence = nlMatch[1].trimStart();
    if (!afterFence) return null;
    return afterFence.startsWith('{');
  }

  return false;
}

// Extract JSON from potentially markdown-wrapped content
// Handles: raw JSON, ```json ... ```, ``` ... ```, or JSON embedded in text
function extractJSON(content: string): any {
  if (!content || typeof content !== 'string') return null;
  
  const trimmed = content.trim();
  
  // 1. Try direct parse first
  try {
    return JSON.parse(trimmed);
  } catch {}
  
  // 2. Try extracting from markdown code blocks
  // Match ```json ... ``` or ``` ... ```
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {}
  }
  
  // 3. Try finding JSON object anywhere in the string
  // Look for outermost { ... }
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
  }
  
  // 4. Try finding JSON array anywhere in the string
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch {}
  }
  
  return null;
}

// Shuffle array helper (Fisher-Yates)
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Promise timeout helper
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

// ============================================
// BROWSER-USE TYPES AND INTERFACES
// ============================================

interface BrowserState {
  url: string;
  title?: string;
  dom_tree: string;
  screenshot?: string;  // base64
  viewport: { width: number; height: number };
  scroll_position: { 
    x: number; 
    y: number;
    pages_above?: number;
    pages_below?: number;
    total_pages?: number;
  };
  tabs?: { id: string; url: string; title: string }[];
  page_stats?: {
    links: number;
    interactive: number;
    iframes: number;
    scroll_containers: number;
    images: number;
    total_elements: number;
  };
  recent_events?: string[];
  closed_popups?: string[];
}

interface ActionHistoryEntry {
  step: number;
  thinking?: string;
  action: string;
  index?: number;
  coordinates?: { x: number; y: number };
  element_description?: string;
  params?: Record<string, any>;  // Action-specific parameters (text, url, key, etc.)
  result: { success: boolean; error?: string; error_type?: string };
  screenshot?: string;  // base64, for vision providers
}

interface BrowserUseRequest {
  model: string;
  task: string;
  browser_state: BrowserState;
  action_history: ActionHistoryEntry[];
  available_actions: string[];
  model_seed?: number;
  mode?: 'default' | 'claude';
  user_id?: string;  // Real user ID for claude-mode credential lookup (API key may map to a shared worker user)
  oauth_token?: string;  // Claude OAuth token provided by caller (agent worker)
}

interface UnifiedAction {
  action: string;
  thinking?: string;
  index?: number;
  coordinates?: { x: number; y: number };
  element_description?: string;
  params?: Record<string, any>;
}

// Detect if a request is a browser-use request (has browser_state field)
function isBrowserUseRequest(body: any): body is BrowserUseRequest {
  return body.browser_state && body.task && body.available_actions;
}

// ============================================
// BROWSER-USE PROVIDER TRANSFORMS
// ============================================

// Browser tool definitions - using Python agent naming conventions
// Each tool has: name, description, params with types and descriptions
const BROWSER_USE_TOOLS: Record<string, { description: string; params: Record<string, { type: string; description: string; required?: boolean }> }> = {
  // === NAVIGATION ===
  goto: {
    description: 'Navigate to a URL',
    params: {
      url: { type: 'string', description: 'URL to navigate to', required: true }
    }
  },
  navback: {
    description: 'Go back to the previous page in browser history',
    params: {}
  },
  
  // === WAITING ===
  wait: {
    description: 'Wait for x seconds (capped at 30s)',
    params: {
      seconds: { type: 'integer', description: 'Seconds to wait (default: 3)' }
    }
  },
  
  // === CLICKING ===
  click: {
    description: 'Click element by index',
    params: {
      index: { type: 'integer', description: 'Element index from browser_state', required: true }
    }
  },
  // Coordinate-based clicking (for vision models)
  click_coordinates: {
    description: 'Click at specific coordinates (for vision models when index unavailable)',
    params: {
      x: { type: 'integer', description: 'X coordinate', required: true },
      y: { type: 'integer', description: 'Y coordinate', required: true }
    }
  },
  
  // === TEXT INPUT ===
  input_text: {
    description: 'Input text into element by index',
    params: {
      index: { type: 'integer', description: 'Element index from browser_state', required: true },
      text: { type: 'string', description: 'Text to input', required: true },
      clear: { type: 'boolean', description: 'Clear field before typing (default: true)' }
    }
  },
  
  // === KEYBOARD ===
  press_key: {
    description: 'Send keyboard keys or shortcuts',
    params: {
      keys: { type: 'string', description: 'Keys (Escape, Enter, PageDown) or shortcuts (Control+o)', required: true }
    }
  },
  
  // === SCROLLING ===
  scroll: {
    description: 'Scroll by pages. Use down=True for scroll down, down=False for scroll up. Use index for scroll containers.',
    params: {
      down: { type: 'boolean', description: 'True=scroll down, False=scroll up (default: true)', required: true },
      pages: { type: 'number', description: '0.5=half page, 1=full page, 10=to bottom/top (default: 1.0)' },
      index: { type: 'integer', description: 'Optional element index to scroll within specific container' }
    }
  },
  find_text: {
    description: 'Scroll to specific text on the page',
    params: {
      text: { type: 'string', description: 'Text to find and scroll to', required: true }
    }
  },
  
  // === EXTRACTION ===
  extract: {
    description: 'LLM extracts structured data from page markdown. Use when on right page and know what to extract.',
    params: {
      query: { type: 'string', description: 'What to extract from the page', required: true },
      extract_links: { type: 'boolean', description: 'Set True to extract URLs (default: false)' }
    }
  },
  // === DROPDOWNS ===
  dropdown_options: {
    description: 'Get all options from a native dropdown or ARIA menu',
    params: {
      index: { type: 'integer', description: 'Element index of the dropdown', required: true }
    }
  },
  select_dropdown: {
    description: 'Set the option of a <select> element',
    params: {
      index: { type: 'integer', description: 'Element index of the dropdown', required: true },
      text: { type: 'string', description: 'Exact text of the option to select', required: true }
    }
  },
  
  // === JAVASCRIPT ===
  evaluate: {
    description: 'Execute browser JavaScript. Wrap in IIFE with try-catch. Use for hover, drag, custom selectors, shadow DOM.',
    params: {
      code: { type: 'string', description: 'JavaScript code to execute', required: true }
    }
  },
  
  // === TAB MANAGEMENT ===
  switch_tab: {
    description: 'Switch to another open tab by tab_id (last 4 chars of target_id shown in browser state)',
    params: {
      tab_id: { type: 'string', description: '4-char tab ID', required: true }
    }
  },
  close_tab: {
    description: 'Close a tab by tab_id. Closes current tab if omitted.',
    params: {
      tab_id: { type: 'string', description: '4-char tab ID (optional, closes current if omitted)' }
    }
  },
  open_new_tab: {
    description: 'Open a new browser tab, optionally navigating to a URL',
    params: {
      url: { type: 'string', description: 'URL to open in new tab (defaults to about:blank)' }
    }
  },
  
  // === COMPLETION ===
  done: {
    description: 'Complete the task and provide final result',
    params: {
      text: { type: 'string', description: 'Final result message in the format user requested', required: true },
      success: { type: 'boolean', description: 'True if task completed successfully (default: true)' }
    }
  },
  attempt_completion: {
    description: 'Attempt to complete the task with a result message',
    params: {
      result: { type: 'string', description: 'The result/answer for the user', required: true }
    }
  },
  send_message_to_user: {
    description: 'Send a message to the user (for updates or asking for help)',
    params: {
      message: { type: 'string', description: 'Message content', required: true }
    }
  },
  screenshot: {
    description: 'Take a full-page screenshot of the current page (captures entire page, not just viewport). The screenshot is saved and returned to the orchestrating agent. Only call once per page — one call captures everything.',
    params: {}
  }
};

// Generate tool description string filtered by available_actions
function generateToolDescriptions(availableActions: string[]): string {
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

// Generate JSON action format examples for available actions
function generateActionExamples(availableActions: string[]): string {
  const examples: string[] = [];
  
  for (const actionName of availableActions) {
    const tool = BROWSER_USE_TOOLS[actionName];
    if (!tool) continue;
    
    // Build example params
    const exampleParams: Record<string, string> = {};
    for (const [paramName, paramInfo] of Object.entries(tool.params)) {
      if (paramInfo.required) {
        if (paramInfo.type === 'string') {
          exampleParams[paramName] = `<${paramName}>`;
        } else if (paramInfo.type === 'integer') {
          exampleParams[paramName] = '<index>' as any;
        } else if (paramInfo.type === 'boolean') {
          exampleParams[paramName] = 'true/false' as any;
        } else {
          exampleParams[paramName] = `<${paramInfo.type}>` as any;
        }
      }
    }
    
    const paramsStr = Object.keys(exampleParams).length > 0 
      ? JSON.stringify(exampleParams).replace(/"/g, '') 
      : '';
    
    examples.push(`{"${actionName}": {${paramsStr.slice(1, -1)}}}`);
  }
  
  return examples.join('\n');
}

// Full browser-use system prompt (based on their system_prompt_browser_use.md)
function buildBrowserUseSystemPrompt(availableActions: string[]): string {
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

// Anthropic CUA system prompt (minimal, role-setting)
const ANTHROPIC_CUA_SYSTEM_PROMPT = `You are a computer use assistant that helps automate browser tasks. You have access to a computer tool that allows you to interact with a desktop browser environment.

When given a task:
1. Analyze the current screenshot to understand the page state
2. Reason about what action to take next
3. Use the computer tool to interact with the browser
4. Observe the result and continue until the task is complete

Be precise with your actions. Click accurately on the intended elements. Type text carefully. Scroll when needed to find content.`;

// Models that require vision (coordinate-based or multimodal)
const VISION_MODELS = ['yutori/n1', 'anthropic/claude-cua', 'browser-use'];
// Models that use DOM indices only (no vision needed - reduces tokens and latency)
const DOM_ONLY_MODELS = ['openai/gpt-5.2', 'anthropic/claude-opus-4.6'];

// Build browser-use format messages (used for browser-use LLM and generic LLMs)
// Supports vision by including screenshot in multimodal user message
// Set includeScreenshot=false for DOM-only models to reduce tokens and latency
function transformToBrowserUseFormat(req: BrowserUseRequest, options?: { includeScreenshot?: boolean }): {
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
    scrollText += ` | ${bs.scroll_position.pages_above} pages above, ${bs.scroll_position.pages_below} pages below`;
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
      { type: 'image_url', image_url: { url: imageUrl } }
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
      content: systemPrompt
    },
    {
      role: 'user',
      content: userContent
    }
  ];

  return { messages };
}

// Call browser-use hosted LLM
async function callBrowserUseLLM(
  req: BrowserUseRequest,
  apiKey: string,
  signal?: AbortSignal
): Promise<{ response: any; ttftMs: number; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
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
  
  slog('info', 'browser-use full request:', { data: JSON.stringify(truncateForLogging(requestBody), null, 2) });
  
  const response = await fetch(BROWSER_USE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal
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
  const usage = data.usage ? {
    prompt_tokens: data.usage.prompt_tokens || 0,
    completion_tokens: data.usage.completion_tokens || 0,
    total_tokens: data.usage.total_tokens || 0
  } : undefined;
  return { response: data, ttftMs, usage };
}

// ============================================
// YUTORI N1 TRANSFORM FUNCTIONS
// ============================================

// Map our internal action names to n1-latest native tool names
function mapToYutoriN1ToolName(action: string): string {
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
function buildYutoriToolArgs(
  entry: ActionHistoryEntry,
  viewport: { width: number; height: number }
): Record<string, any> {
  const args: Record<string, any> = {};
  const toolName = mapToYutoriN1ToolName(entry.action);

  // Coordinates: convert viewport pixels to 1000x1000 normalized space
  if (entry.coordinates) {
    args.coordinates = [
      Math.round((entry.coordinates.x / viewport.width) * 1000),
      Math.round((entry.coordinates.y / viewport.height) * 1000)
    ];
    slog('info', '[YUTORI] Coordinate transform', { data: {
      original: `${entry.coordinates.x},${entry.coordinates.y}`,
      normalized: `${args.coordinates[0]},${args.coordinates[1]}`,
      viewport: `${viewport.width}x${viewport.height}`
    } });
  }

  // Tool-specific arguments
  if (toolName === 'type') {
    if (entry.params?.text) args.text = entry.params.text;
    if (entry.params?.press_enter_after !== undefined) args.press_enter_after = entry.params.press_enter_after;
    if (entry.params?.clear_before_typing !== undefined) args.clear_before_typing = entry.params.clear_before_typing;
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
        Math.round((entry.coordinates.y / viewport.height) * 1000)
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
function transformToYutoriFormat(req: BrowserUseRequest): {
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
    { type: 'text', text: `Task: ${req.task}` }
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
          arguments: JSON.stringify(toolArgs)
        }
      }]
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
      content: toolContent
    });
  }

  // Tracing: log Yutori messages summary
  slog('info', '[TRACE] Yutori n1-latest messages:', { data: {
    total: messages.length,
    assistantCount: messages.filter((m: any) => m.role === 'assistant').length,
    toolCount: messages.filter((m: any) => m.role === 'tool').length
  } });

  return { messages };
}

// Call Yutori n1 API
async function callYutoriLLM(
  req: BrowserUseRequest,
  apiKey: string,
  signal?: AbortSignal
): Promise<{ response: any; ttftMs: number; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const { messages } = transformToYutoriFormat(req);
  
  slog('info', 'Yutori request messages count:', { data: messages.length });
  slog('info', 'Yutori request messages:', { data: JSON.stringify(messages, null, 2) });
  
  const requestBody = {
    model: YUTORI_MODEL,
    messages,
    temperature: 0.3
  };
  
  slog('info', 'Yutori full request body:', { data: JSON.stringify(truncateForLogging(requestBody), null, 2) });
  
  const startTime = Date.now();
  
  const response = await fetch(YUTORI_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal
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
  const usage = data.usage ? {
    prompt_tokens: data.usage.prompt_tokens || 0,
    completion_tokens: data.usage.completion_tokens || 0,
    total_tokens: data.usage.total_tokens || 0
  } : undefined;
  return { response: data, ttftMs, usage };
}

// Normalize Yutori n1-latest response to unified action format
// n1-latest returns actions as native tool_calls, reasoning in content
// Coordinates still in 1000x1000 normalized space
function normalizeYutoriResponse(response: any, viewport: { width: number; height: number }): UnifiedAction {
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
      thinking: thinking || 'Task complete'
    };
  }

  // Parse the first tool call
  const firstToolCall = toolCalls[0];
  const toolName = firstToolCall.function?.name;
  let toolArgs: Record<string, any> = {};

  try {
    toolArgs = JSON.parse(firstToolCall.function?.arguments || '{}');
  } catch (e) {
    slog('error', 'Failed to parse tool_call arguments:', { data: firstToolCall.function?.arguments });
    throw new Error(`normalizeYutoriResponse: Failed to parse tool_call arguments: ${firstToolCall.function?.arguments?.slice(0, 200)}`);
  }

  // Convert 1000x1000 coordinates to viewport coordinates
  let coordinates: { x: number; y: number } | undefined;
  if (toolArgs.coordinates && Array.isArray(toolArgs.coordinates)) {
    const [normX, normY] = toolArgs.coordinates;
    coordinates = {
      x: Math.round((normX / 1000) * viewport.width),
      y: Math.round((normY / 1000) * viewport.height)
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
  const validYutoriActions = ['click', 'scroll', 'input_text', 'press_key', 'navback', 'goto', 'wait', 'attempt_completion', 'done', 'hover', 'refresh'];
  if (!validYutoriActions.includes(normalizedAction)) {
    throw new Error(`normalizeYutoriResponse: Unknown action "${normalizedAction}" (raw tool: "${toolName}") - add to yutoriActionMap or validYutoriActions`);
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
    slog('info', `Yutori n1-latest scroll: ${percentAmount}% of ${viewport.height}px → ${normalizedParams.amount}px (direction=${normalizedParams.direction})`);
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
    params: normalizedParams
  };
}

// ============================================
// ANTHROPIC CUA TRANSFORM FUNCTIONS
// ============================================

// Transform unified request to Anthropic CUA format
function transformToAnthropicCUAFormat(req: BrowserUseRequest): {
  messages: any[];
  tools: any[];
} {
  const messages: any[] = [];
  
  // Build initial user message with task and current screenshot
  const userContent: any[] = [
    { type: 'text', text: `Task: ${req.task}` }
  ];
  
  // Add current screenshot if available (base64 only - CUA requires base64)
  if (req.browser_state.screenshot && !req.browser_state.screenshot.startsWith('http')) {
    userContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: req.browser_state.screenshot
      }
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
        content: [{ type: 'text', text: `${entry.thinking || ''}\n\n${contextText}` }]
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
              data: entry.screenshot
            }
          }]
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
          input: cuaAction
        }
      ]
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
            data: entry.screenshot
          }
        });
      }
    } else {
      toolResultContent.push({ 
        type: 'text', 
        text: entry.result.success ? 'Action completed successfully' : `Error: ${entry.result.error}` 
      });
    }
    
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: `tool_${i}`,
        content: toolResultContent
      }]
    });
  }
  
  // CUA computer tool definition
  const tools = [{
    type: 'computer_20251124',
    name: 'computer',
    display_width_px: req.browser_state.viewport.width,
    display_height_px: req.browser_state.viewport.height,
    display_number: 1
  }];
  
  return { messages, tools };
}

// Map our action names to Anthropic CUA action format
function mapToCUAAction(action: string, params?: Record<string, any>, coordinates?: { x: number; y: number }): any {
  switch (action) {
    case 'click':
      return {
        action: 'left_click',
        coordinate: coordinates ? [coordinates.x, coordinates.y] : [0, 0]
      };
    case 'type':
    case 'input_text':
      return { action: 'type', text: params?.text || '' };
    case 'scroll':
    case 'scroll_down':
      return { action: 'scroll', coordinate: coordinates ? [coordinates.x, coordinates.y] : [640, 400], direction: params?.direction || 'down', amount: params?.amount || 300 };
    case 'scroll_up':
      return { action: 'scroll', coordinate: coordinates ? [coordinates.x, coordinates.y] : [640, 400], direction: 'up', amount: params?.amount || 300 };
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
async function callAnthropicCUA(
  req: BrowserUseRequest,
  apiKey: string
): Promise<{ response: any; ttftMs: number; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const { messages, tools } = transformToAnthropicCUAFormat(req);
  
  slog('info', 'Anthropic CUA request messages count:', { data: messages.length });
  
  const requestBody = {
    model: ANTHROPIC_CUA_MODEL,
    max_tokens: 1024,
    system: ANTHROPIC_CUA_SYSTEM_PROMPT,
    tools,
    messages
  };
  
  slog('info', 'Anthropic CUA request:', { data: JSON.stringify(requestBody, null, 2).slice(0, 1000) });
  
  const startTime = Date.now();
  
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': ANTHROPIC_CUA_BETA,
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody)
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
  const usage = data.usage ? {
    prompt_tokens: data.usage.input_tokens || 0,
    completion_tokens: data.usage.output_tokens || 0,
    total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
  } : undefined;
  return { response: data, ttftMs, usage };
}

// Normalize Anthropic CUA response to unified action format
function normalizeAnthropicCUAResponse(response: any): UnifiedAction {
  slog('info', 'Normalizing Anthropic CUA response');
  
  const content = response.content || [];
  
  // Find text and tool_use in content
  const textPart = content.find((c: any) => c.type === 'text');
  const toolUse = content.find((c: any) => c.type === 'tool_use');
  
  if (!toolUse) {
    return {
      action: 'done',
      thinking: textPart?.text || 'No action returned'
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
      action = 'input_text';  // Map to Python expected name
      if (toolUse.input?.text) normalizedParams.text = toolUse.input.text;
      break;
    case 'scroll':
      action = 'scroll';  // Use unified 'scroll' action
      if (toolUse.input?.direction) {
        normalizedParams.direction = toolUse.input.direction;
        normalizedParams.amount = 300; // Default scroll amount
      }
      if (toolUse.input?.coordinate) {
        coordinates = { x: toolUse.input.coordinate[0], y: toolUse.input.coordinate[1] };
      }
      break;
    case 'key':
      action = 'press_key';  // Map to Python expected name
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
      throw new Error(`normalizeAnthropicCUAResponse: Unmapped CUA action "${cuaAction}" - add to switch statement`);
  }
  
  return {
    action,
    thinking: textPart?.text,
    coordinates,
    params: normalizedParams
  };
}

// ============================================
// GENERIC LLM TRANSFORM FUNCTIONS
// ============================================

// Call generic LLM via OpenRouter using browser-use format
async function callGenericLLM(
  req: BrowserUseRequest,
  model: string,
  openRouterKey: string,
  supabaseUrl: string,
  signal?: AbortSignal
): Promise<{ response: any; ttftMs: number; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  // Check if this is a DOM-only model (no vision needed)
  const isDomOnly = DOM_ONLY_MODELS.includes(model);

  // transformToBrowserUseFormat already includes the dynamic system prompt
  // For DOM-only models, skip screenshot to reduce tokens and improve latency
  const { messages } = transformToBrowserUseFormat(req, { includeScreenshot: !isDomOnly });

  slog('info', `Generic LLM request to: ${model} (DOM-only: ${isDomOnly})`);
  slog('info', 'Messages count:', { data: messages.length });

  const startTime = Date.now();

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openRouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': supabaseUrl,
      'X-Title': 'Rose Browser Use'
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 1024,
      response_format: { type: 'json_object' }
    }),
    signal
  });

  const ttftMs = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    slog('error', 'OpenRouter API error:', { data: [response.status, errorText] });
    throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  
  // Extract the content from OpenRouter response format
  const content = data.choices?.[0]?.message?.content;
  slog('info', 'Generic LLM raw content:', { data: content });
  
  // Parse JSON content and return in browser-use compatible format
  let completion: any;
  try {
    completion = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    completion = { action: [], thinking: content };
  }

  // Extract usage from OpenRouter response
  const usage = data.usage ? {
    prompt_tokens: data.usage.prompt_tokens || 0,
    completion_tokens: data.usage.completion_tokens || 0,
    total_tokens: data.usage.total_tokens || 0
  } : undefined;

  return {
    response: { completion },
    ttftMs,
    usage
  };
}

// Normalize browser-use response to unified action format
function normalizeBrowserUseResponse(response: any): UnifiedAction {
  slog('info', 'Normalizing response:', { data: JSON.stringify(response, null, 2) });
  
  // browser-use returns { completion: { thinking, action: [...], ... }, usage }
  // or sometimes just the completion directly
  const completion = response.completion || response;
  
  // Check if completion is a string (raw LLM response)
  if (typeof completion === 'string') {
    // Try to extract JSON (handles markdown-wrapped JSON)
    const parsed = extractJSON(completion);
    if (parsed) {
      return normalizeBrowserUseResponse({ completion: parsed });
    }
    slog('info', 'Could not extract JSON from completion:', { data: completion.slice(0, 300) });
    throw new Error(`normalizeBrowserUseResponse: Could not extract JSON from completion: ${completion.slice(0, 200)}`);
  }
  
  // Extract action array - it could be in different places
  let actions = completion.action;
  if (!actions || actions.length === 0) {
    // Model returned no actions - throw error to trigger provider failover
    slog('info', 'No actions in completion, triggering failover to next provider');
    throw new Error('normalizeBrowserUseResponse: No actions returned in completion');
  }
  
  const firstAction = actions[0];
  slog('info', 'First action:', { data: JSON.stringify(firstAction, null, 2) });
  
  // Action can be in different formats:
  // 1. { action_name: "click", index: 5 } - flat format
  // 2. { click: { index: 5 } } - nested format (browser-use native)
  // 3. { action_name: { ...params } } - semi-nested
  
  let actionName: string;
  let params: Record<string, any> = {};
  let index: number | undefined;
  
  if (firstAction.action_name) {
    // Format 1 or 3: has explicit action_name field
    actionName = firstAction.action_name;
    params = { ...firstAction };
    delete params.action_name;
    index = firstAction.index;
  } else {
    // Format 2: nested { click: { index: 5 } }
    const keys = Object.keys(firstAction);
    actionName = keys[0];
    params = firstAction[actionName] || {};
    index = params.index;
  }
  
  // Map action names to Python agent expected names
  // Browser-use native actions: search, navigate, go_back, wait, click, input, upload_file,
  // switch, close, extract, scroll, send_keys, find_text, screenshot, dropdown_options, select_dropdown, evaluate, done
  const actionNameMap: Record<string, string> = {
    'navigate': 'goto',
    'go_back': 'navback',
    'input': 'input_text',
    'send_keys': 'press_key',
    'switch': 'switch_tab',
    'close': 'close_tab',
    'done': 'attempt_completion',
  };
  
  const normalizedAction = actionNameMap[actionName] || actionName;
  
  // Validate action is one we support
  const validActions = [
    'click', 'click_coordinates', 'scroll', 'wait', 'extract', 'evaluate', 
    'dropdown_options', 'select_dropdown', 'screenshot', 
    'find_text', 'upload_file', 'search',
    'goto', 'navback', 'input_text', 'press_key', 
    'switch_tab', 'close_tab', 'open_new_tab', 'attempt_completion'
  ];
  if (!validActions.includes(normalizedAction)) {
    throw new Error(`normalizeBrowserUseResponse: Unknown action "${normalizedAction}" (raw: "${actionName}") - add to actionNameMap or validActions`);
  }
  
  // Convert click_coordinates to click with coordinates
  if (normalizedAction === 'click_coordinates') {
    const x = params.x ?? params.coordinate_x;
    const y = params.y ?? params.coordinate_y;
    if (x === undefined || y === undefined) {
      throw new Error(`normalizeBrowserUseResponse: click_coordinates requires x and y, got: ${JSON.stringify(params)}`);
    }
    return {
      action: 'click',
      thinking: completion.next_goal || completion.thinking,
      coordinates: { x, y },
      params: {}
    };
  }
  
  // Validate click action has required index (DOM-based models must return index)
  if (normalizedAction === 'click' && index === undefined) {
    throw new Error(`normalizeBrowserUseResponse: click action requires element index, got none. Raw action: ${JSON.stringify(firstAction)}`);
  }
  
  // Normalize params to Python agent expected format
  const normalizedParams: Record<string, any> = {};

  // Handle different param formats
  if (params.url) normalizedParams.url = params.url;
  if (params.text) normalizedParams.text = params.text;
  if (params.typing_text) normalizedParams.text = params.typing_text; // Yutori format

  // File upload - filename can be at top level (firstAction) or in params
  if (firstAction.filename) normalizedParams.filename = firstAction.filename;
  else if (params.filename) normalizedParams.filename = params.filename;
  if (firstAction.file_path) normalizedParams.file_path = firstAction.file_path;
  else if (params.file_path) normalizedParams.file_path = params.file_path;

  // press_key: map 'keys' to 'key'
  if (params.key) normalizedParams.key = params.key;
  if (params.keys) normalizedParams.key = params.keys;
  
  // extract: map 'query' to 'instruction'
  if (params.instruction) normalizedParams.instruction = params.instruction;
  if (params.query) normalizedParams.instruction = params.query;
  if (params.extract_links !== undefined) normalizedParams.extract_links = params.extract_links;
  
  if (params.code) normalizedParams.code = params.code;
  
  // select_dropdown: map 'text' to 'value' (but text is also used for input_text)
  // Only map to 'value' for select_dropdown action
  if (normalizedAction === 'select_dropdown' && params.text) {
    normalizedParams.value = params.text;
  } else if (params.value) {
    normalizedParams.value = params.value;
  }
  
  if (params.tab_id) normalizedParams.tab_id = params.tab_id;
  if (params.message) normalizedParams.message = params.message;
  if (params.reasoning) normalizedParams.reasoning = params.reasoning;
  if (params.reason) normalizedParams.reason = params.reason;
  
  // wait: convert 'seconds' to 'time_ms'
  if (params.seconds !== undefined) {
    normalizedParams.time_ms = params.seconds * 1000;
  }
  if (params.timeout !== undefined) {
    normalizedParams.time_ms = params.timeout; // Already in ms
  }
  if (params.time_ms !== undefined) {
    normalizedParams.time_ms = params.time_ms;
  }
  
  // scroll: convert 'down'/'pages' to 'direction'/'amount'
  if (actionName === 'scroll_up') {
    normalizedParams.direction = 'up';
    normalizedParams.amount = 300; // Default scroll amount
  } else if (actionName === 'scroll_down') {
    normalizedParams.direction = 'down';
    normalizedParams.amount = 300;
  } else if (params.down !== undefined) {
    normalizedParams.direction = params.down ? 'down' : 'up';
    // Convert pages to pixel amount (1 page ≈ viewport height ≈ 600px)
    const pages = params.pages !== undefined ? params.pages : 1.0;
    normalizedParams.amount = Math.round(pages * 600);
  } else if (params.direction) {
    normalizedParams.direction = params.direction;
    normalizedParams.amount = params.amount || 300;
  }
  
  // Copy index to params if present
  if (index !== undefined) {
    normalizedParams.index = index;
  }
  
  return {
    action: normalizedAction,
    thinking: completion.next_goal || completion.thinking,
    index: index,
    coordinates: params.coordinate_x !== undefined ? {
      x: params.coordinate_x,
      y: params.coordinate_y
    } : undefined,
    element_description: params.element_description,
    params: normalizedParams
  };
}

// Model preferences - hardcoded mappings for SMART/FAST/CHEAP
// FAST uses Cerebras for ultra-low latency inference
type ModelPreference = 'SMART' | 'FAST' | 'CHEAP';
const MODEL_PREFERENCES: Record<ModelPreference, { model: string; isCerebras: boolean }> = {
  'SMART': { model: 'openai/gpt-5.2', isCerebras: false },
  'FAST': { model: 'qwen-3-235b-a22b-instruct-2507', isCerebras: true },
  'CHEAP': { model: 'google/gemini-2.5-flash', isCerebras: false }
};

// Cerebras API base URL (OpenAI-compatible)
const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';

// Anthropic API for direct Claude calls (structured outputs require beta header)
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_BETA_HEADER = 'structured-outputs-2025-11-13';

// Max anyOf branches Anthropic structured outputs supports
const ANTHROPIC_MAX_ANYOF_BRANCHES = 8;

// ============================================
// VISION-CAPABLE MODELS
// ============================================
// Models that can process image_url content in messages
const VISION_CAPABLE_MODELS = new Set([
  // OpenAI
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-5.2',
  // Google
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'google/gemini-3-pro-preview',
  // Anthropic
  'anthropic/claude-sonnet-4',
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-opus-4',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-sonnet-4.6',
  // X.AI
  'x-ai/grok-4.1-fast',
  'x-ai/grok-4.1',
]);

// Check if a model supports vision (image inputs)
function isVisionCapable(model: string): boolean {
  return VISION_CAPABLE_MODELS.has(model);
}

// Detect if messages contain __screenshot_base64__ markers in tool messages
function hasScreenshotMarkers(messages: any[]): boolean {
  for (const msg of messages) {
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      if (msg.content.includes('__screenshot_base64__')) {
        return true;
      }
    }
  }
  return false;
}

// Transform messages for vision-capable models
// Converts __screenshot_base64__ markers in tool messages to proper multimodal format
// NOTE: OpenAI/OpenRouter don't support image_url in tool messages, so we inject
// a user message with the image right after the tool message
function transformMessagesForVision(messages: any[]): any[] {
  const transformed: any[] = [];
  
  for (const msg of messages) {
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.includes('__screenshot_base64__')) {
      try {
        const parsed = JSON.parse(msg.content);
        const base64Data = parsed.__screenshot_base64__;
        
        if (base64Data) {
          // Remove base64 from JSON, add flag
          const toolContent = { ...parsed };
          delete toolContent.__screenshot_base64__;
          toolContent.screenshot_attached = true;
          
          // Keep tool message with cleaned content
          transformed.push({
            ...msg,
            content: JSON.stringify(toolContent)
          });
          
          // Inject user message with the image right after
          transformed.push({
            role: 'user',
            content: [
              { type: 'text', text: '[Screenshot from browser]' },
              { 
                type: 'image_url', 
                image_url: { 
                  url: `data:image/png;base64,${base64Data}` 
                } 
              }
            ]
          });
        } else {
          transformed.push(msg);
        }
      } catch (e) {
        // If JSON parsing fails, keep original message
        transformed.push(msg);
      }
    } else {
      transformed.push(msg);
    }
  }
  
  return transformed;
}

// Get messages appropriate for a model based on vision capability
function getMessagesForModel(messages: any[], model: string): any[] {
  if (isVisionCapable(model) && hasScreenshotMarkers(messages)) {
    return transformMessagesForVision(messages);
  }
  // Non-vision models get the raw messages (base64 stays as string in tool content)
  return messages;
}

// ============================================
// LATENCY CACHE FUNCTIONS
// ============================================

// Standard test prompt for latency probes - minimal tokens, consistent across all models
const LATENCY_PROBE_MESSAGES = [
  { role: "user", content: "Reply with just 'ok'" }
];
const LATENCY_PROBE_MAX_TOKENS = 16;

interface LatencyEntry {
  model: string;
  pool: string;
  latencyMs: number;
  measuredAt: Date;
}

// Get cached latencies for a pool (only entries < 1 min old)
// Returns both the latencies and whether any models are missing/stale
async function getCachedLatencies(supabase: any, pool: string, poolModels: string[]): Promise<{
  latencies: Map<string, number>;
  needsRefresh: boolean;
  missingModels: string[];
}> {
  const cutoff = new Date(Date.now() - LATENCY_CACHE_TTL_MS).toISOString();
  slog('info', `Fetching cached latencies for ${pool} (cutoff: ${cutoff})`);
  
  const { data, error } = await supabase
    .from('RoseModelLatency')
    .select('model, latencyMs, measuredAt')
    .eq('pool', pool)
    .gt('measuredAt', cutoff);
  
  const latencies = new Map<string, number>();
  if (error) {
    slog('error', 'Error fetching latency cache:', { data: error });
    return { latencies, needsRefresh: true, missingModels: poolModels };
  }
  
  for (const entry of data || []) {
    latencies.set(entry.model, entry.latencyMs);
  }
  
  // Check which models are missing from cache
  const missingModels = poolModels.filter(model => !latencies.has(model));
  const needsRefresh = missingModels.length > 0;
  
  if (latencies.size === 0) {
    slog('info', `No cached latencies for ${pool} (cache empty or expired)`);
  } else {
    slog('info', `Cached latencies for ${pool}:`, { data: Object.fromEntries(latencies) });
    if (missingModels.length > 0) {
      slog('info', `Missing from cache: ${missingModels.join(', ')}`);
    }
  }
  
  return { latencies, needsRefresh, missingModels };
}

// Fire latency probes to specified models (runs in background, updates cache)
async function fireLatencyProbes(
  models: string[],
  pool: string,
  openRouterKey: string,
  supabaseUrl: string,
  supabase: any
): Promise<void> {
  slog('info', `Firing latency probes for ${models.length} models: ${models.join(', ')}`);
  
  const probePromises = models.map(async (model) => {
    const startTime = Date.now();
    const controller = new AbortController(); // To kill the request immediately
    
    try {
      let response: globalThis.Response;
      
      // Call Anthropic directly for Claude models (same as race)
      if (isAnthropicModel(model)) {
        const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
        if (!anthropicKey) {
          slog('error', `Probe skipped for ${model}: no ANTHROPIC_API_KEY`);
          return;
        }
        
        const anthropicModel = getAnthropicModelName(model);
        response = await fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: anthropicModel,
            messages: [{ role: 'user', content: "Reply with just 'ok'" }],
            max_tokens: LATENCY_PROBE_MAX_TOKENS,
            stream: true
          }),
          signal: controller.signal
        });
      } else {
        // OpenRouter for other models
        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openRouterKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': supabaseUrl,
            'X-Title': 'Rose AI - Latency Probe'
          },
          body: JSON.stringify({
            model,
            messages: LATENCY_PROBE_MESSAGES,
            max_tokens: LATENCY_PROBE_MAX_TOKENS,
            stream: true
          }),
          signal: controller.signal  // Enable abort
        });
      }
      
      if (!response.ok) {
        slog('error', `Probe failed for ${model}: ${response.status}`);
        return;
      }
      
      const reader = response.body?.getReader();
      if (!reader) {
        slog('error', `Probe no body for ${model}`);
        return;
      }
      
      const decoder = new TextDecoder();
      let buffer = '';
      
      // Read chunks until we get first contentful token
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        
        // Check each line for contentful data
        for (const line of lines) {
          if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
          
          try {
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;
            
            const parsed = JSON.parse(jsonStr);
            
            // Handle both OpenRouter and Anthropic streaming formats
            let hasContent = false;
            if (parsed.choices?.[0]?.delta) {
              // OpenRouter format
              const delta = parsed.choices[0].delta;
              hasContent = delta.content || delta.reasoning;
            } else if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              // Anthropic format
              hasContent = true;
            }
            
            if (hasContent) {
              const ttftMs = Date.now() - startTime;
              slog('info', `Probe result: ${model} = ${ttftMs}ms (first contentful token)`);
              
              // IMMEDIATELY kill the entire HTTP connection
              controller.abort();
              
              // Fire-and-forget cache update
              updateLatencyCache(supabase, model, pool, ttftMs).catch(() => {});
              return;
            }
          } catch (e) {
            // Skip unparseable lines
          }
        }
        
        // Keep only the last incomplete line in buffer
        buffer = lines[lines.length - 1] || '';
      }
      
      slog('error', `Probe no contentful data for ${model}`);
      
    } catch (error) {
      // Ignore abort errors (expected when we kill the request)
      if (error instanceof DOMException && error.name === 'AbortError') return;
      slog('error', `Probe error for ${model}:`, { data: error });
    }
  });
  
  // Wait for all probes to complete
  await Promise.allSettled(probePromises);
  slog('info', `All latency probes completed for ${pool}`);
}

// Update latency cache for a model (upsert)
// Ignores outlier latencies (> 10s) which are likely timeouts or errors
async function updateLatencyCache(supabase: any, model: string, pool: string, latencyMs: number): Promise<void> {
  // Pool-aware outlier threshold (browser-use completions take 2-15s normally)
  const MAX_VALID_LATENCY_MS = pool === 'rose-1-browser-use' ? 60000 : 10000;
  if (latencyMs > MAX_VALID_LATENCY_MS) {
    slog('warn', `Ignoring outlier latency for ${model}: ${latencyMs}ms > ${MAX_VALID_LATENCY_MS}ms`);
    return;
  }
  
  // Generate a UUID for the id field
  const id = crypto.randomUUID();
  
  const { error } = await supabase
    .from('RoseModelLatency')
    .upsert({
      id,
      model,
      pool,
      latencyMs,
      measuredAt: new Date().toISOString()
    }, {
      onConflict: 'model,pool'
    });
  
  if (error) {
    slog('error', `Error updating latency cache for ${model}:`, { data: error });
  } else {
    slog('info', `Updated latency cache: ${model} = ${latencyMs}ms`);
  }
}

// Increment loser's cached latency by 80ms (reduces sandbagging, gives them better chance next race)
// Uses atomic SQL increment via RPC to avoid race conditions
const LOSER_LATENCY_INCREMENT_MS = 80;

async function incrementLoserLatency(supabase: any, model: string, pool: string): Promise<void> {
  // Use raw SQL for atomic increment - Supabase doesn't have direct increment API
  // We'll use UPDATE with latencyMs = latencyMs + 10
  const { error } = await supabase.rpc('increment_loser_latency', {
    p_model: model,
    p_pool: pool,
    p_increment: LOSER_LATENCY_INCREMENT_MS
  });
  
  if (error) {
    // Fallback: if RPC doesn't exist, do manual increment (less atomic but works)
    slog('warn', `RPC increment failed for ${model}, trying manual update:`, { data: error.message });
    
    // Fetch current value
    const { data } = await supabase
      .from('RoseModelLatency')
      .select('latencyMs')
      .eq('model', model)
      .eq('pool', pool)
      .single();
    
    if (data) {
      const newLatency = data.latencyMs + LOSER_LATENCY_INCREMENT_MS;
      await supabase
        .from('RoseModelLatency')
        .update({ latencyMs: newLatency, measuredAt: new Date().toISOString() })
        .eq('model', model)
        .eq('pool', pool);
      slog('info', `Loser ${model}: latency incremented ${data.latencyMs} → ${newLatency}ms (less sandbagging)`);
    }
  } else {
    slog('info', `Loser ${model}: latency incremented by ${LOSER_LATENCY_INCREMENT_MS}ms (atomic)`);
  }
}

// ============================================
// CONVERSATION MODEL TRACKING
// ============================================

// Get existing model selection for a conversation
async function getConversationModel(supabase: any, conversationId: string): Promise<string | null> {
  slog('info', `Looking up model for conversation: ${conversationId}`);
  
  const { data, error } = await supabase
    .from('RoseConversationModel')
    .select('model')
    .eq('conversationId', conversationId)
    .maybeSingle();  // Use maybeSingle to avoid error when no rows found
  
  if (error) {
    slog('error', `Error looking up conversation model:`, { data: error });
    return null;
  }
  
  if (!data) {
    slog('info', `No existing model for conversation ${conversationId}`);
    return null;
  }
  
  slog('info', `Found existing model for conversation ${conversationId}: ${data.model}`);
  return data.model;
}

// Save model selection for a conversation
async function saveConversationModel(supabase: any, conversationId: string, model: string, pool: string): Promise<void> {
  slog('info', `Saving model ${model} for conversation ${conversationId}`);
  
  // Generate a UUID for the id field
  const id = crypto.randomUUID();
  
  const { error } = await supabase
    .from('RoseConversationModel')
    .upsert({
      id,
      conversationId,
      model,
      pool,
      createdAt: new Date().toISOString()
    }, {
      onConflict: 'conversationId'
    });
  
  if (error) {
    slog('error', `Error saving conversation model:`, { data: error });
  } else {
    slog('info', `Saved model for conversation ${conversationId}: ${model}`);
  }
}

// ============================================
// TRIO RACING LOGIC
// ============================================

interface RacingModel {
  model: string;
  latencyMs: number;
  delayMs: number;
}

// Racing configuration (overridable for browser-use completion racing)
interface RacingConfig {
  maxLatencyCapMs: number;
  maxDelayCapMs: number;
  defaultLatencyMs: number;
  trioSize: number;
}

// Waterfall streaming: try models sequentially until one succeeds.
// Unlike trio racing (parallel), this sends input tokens to only ONE model per request.
async function waterfallStream(
  pool: string[],
  messages: any[],
  temperature: number | undefined,
  maxTokens: number | undefined,
  seed: number | undefined,
  tools: any[] | undefined,
  toolChoice: any,
  responseFormat: any,
  reasoning: { max_tokens?: number } | undefined,
  openRouterKey: string,
  supabaseUrl: string,
  requestedModel: string,
  poolName: string,
  poolSize: number,
  conversation_id: string | null,
  supabase: any,
  claudeTokenError?: string,
): Promise<Response> {
  const errors: string[] = [];

  for (let i = 0; i < pool.length; i++) {
    const model = pool[i];
    const isLast = i === pool.length - 1;
    slog('info', `Waterfall [${i + 1}/${pool.length}]: trying ${model}`);

    try {
      const response = await withTimeout(
        handleStreaming(
          model,
          messages,
          temperature,
          maxTokens,
          seed,
          tools,
          toolChoice,
          responseFormat,
          reasoning,
          openRouterKey,
          supabaseUrl,
          requestedModel,
          false,  // isCerebras
          poolName,
          poolSize,
          undefined, undefined, undefined,  // claudeAuth, skipCache, stallConfig
          claudeTokenError,
        ),
        WATERFALL_TIMEOUT_MS,
        `waterfall-${model}`
      );

      // handleStreaming returns a Response — check if it's an error status
      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown');
        const msg = `${model} returned ${response.status}: ${errText.slice(0, 200)}`;
        slog('warn', `Waterfall: ${msg}`);
        errors.push(msg);
        continue;
      }

      slog('info', `Waterfall winner: ${model} (attempt ${i + 1}/${pool.length})`);

      // Save winning model for conversation
      if (conversation_id) {
        await saveConversationModel(supabase, conversation_id, model, poolName);
      }

      return response;
    } catch (err: any) {
      const msg = `${model} failed: ${err.message || err}`;
      slog('warn', `Waterfall: ${msg}`);
      errors.push(msg);

      if (!isLast) {
        slog('info', `Waterfall: falling through to next model`);
      }
    }
  }

  // All models failed
  slog('error', `Waterfall: all ${pool.length} models failed`, { data: errors });
  return new Response(JSON.stringify({
    error: 'All waterfall models failed',
    details: errors,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status: 500,
  });
}

// Select a random trio from the pool, calculate delays based on cached latencies
//
// Strategy:
// 1. First, exclude models with latency > hard cap
// 2. Group remaining models by latency bands (within delay cap of each other)
// 3. Prefer the fastest band, randomly select trio from that band
// 4. Add delays to fast models so they finish at same time as the slowest in the trio
function selectRacingTrio(
  pool: string[],
  cachedLatencies: Map<string, number>,
  config?: Partial<RacingConfig>
): RacingModel[] {
  const maxLatencyCapMs = config?.maxLatencyCapMs ?? MAX_LATENCY_CAP_MS;
  const maxDelayCapMs = config?.maxDelayCapMs ?? MAX_DELAY_CAP_MS;
  const defaultLatencyMs = config?.defaultLatencyMs ?? 500;
  const trioSize = config?.trioSize ?? TRIO_SIZE;

  // Get all models with their latencies
  const modelsWithLatency = pool.map(model => ({
    model,
    latencyMs: cachedLatencies.get(model) || defaultLatencyMs
  }));

  // Filter out models exceeding hard latency cap
  const underHardCap = modelsWithLatency.filter(m => {
    if (m.latencyMs > maxLatencyCapMs) {
      slog('warn', `Excluding ${m.model} - latency ${m.latencyMs}ms exceeds ${maxLatencyCapMs}ms cap`);
      return false;
    }
    return true;
  });

  if (underHardCap.length === 0) {
    slog('warn', `No eligible models after ${maxLatencyCapMs}ms cap, using full pool with fastest models`);
    const sorted = modelsWithLatency.sort((a, b) => a.latencyMs - b.latencyMs);
    return sorted.slice(0, trioSize).map(m => ({ ...m, delayMs: 0 }));
  }

  // Sort by latency (fastest first)
  underHardCap.sort((a, b) => a.latencyMs - b.latencyMs);

  // Find models within delay cap of the fastest model
  const fastestLatency = underHardCap[0].latencyMs;
  const withinDelayCap = underHardCap.filter(m =>
    (m.latencyMs - fastestLatency) <= maxDelayCapMs
  );

  // Log what we excluded due to delay cap
  const excludedByDelay = underHardCap.filter(m =>
    (m.latencyMs - fastestLatency) > maxDelayCapMs
  );
  for (const m of excludedByDelay) {
    slog('warn', `Excluding ${m.model} - latency ${m.latencyMs}ms is ${m.latencyMs - fastestLatency}ms slower than fastest (${fastestLatency}ms), exceeds ${maxDelayCapMs}ms delay cap`);
  }

  // ALWAYS include the fastest model, then randomly select the rest
  const fastestModel = withinDelayCap[0];  // Already sorted, index 0 is fastest
  const otherModels = withinDelayCap.slice(1);

  // Shuffle the rest and pick trioSize - 1
  const shuffledOthers = [...otherModels].sort(() => Math.random() - 0.5);
  const randomOthers = shuffledOthers.slice(0, Math.min(trioSize - 1, shuffledOthers.length));
  
  // Combine: fastest + random others
  const selectedModels = [fastestModel, ...randomOthers];
  slog('info', `Trio: fastest=${fastestModel.model}, others=[${randomOthers.map(m => m.model).join(', ')}]`);
  
  // Find the slowest model in the selected trio
  const slowestInTrio = Math.max(...selectedModels.map(m => m.latencyMs));
  
  // Calculate delays: fast models wait so all finish ~simultaneously
  const racingModels: RacingModel[] = selectedModels.map(m => ({
    model: m.model,
    latencyMs: m.latencyMs,
    delayMs: slowestInTrio - m.latencyMs
  }));
  
  slog('info', `Racing trio (target finish ~${slowestInTrio}ms):`, { data: racingModels.map(m => `${m.model} (${m.latencyMs}ms + ${m.delayMs}ms delay = ${m.latencyMs + m.delayMs}ms)`) });
  
  return racingModels;
}

// Race multiple models and return the first response
// Uses AbortController to cancel losing requests and save API costs
async function raceModels(
  racingModels: RacingModel[],
  messages: any[],
  temperature: number | undefined,
  maxTokens: number | undefined,
  seed: number | undefined,
  tools: any[] | undefined,
  toolChoice: any,
  responseFormat: any,
  reasoning: any,
  openRouterKey: string,
  supabaseUrl: string,
  supabase: any,
  pool: string,
  timings: { [key: string]: number }  // Track timing breakdown
): Promise<{ model: string; reader: ReadableStreamDefaultReader<Uint8Array>; ttftMs: number; firstData: string }> {
  
  slog('info', `Starting race with ${racingModels.length} models:`, { data: racingModels.map(m => `${m.model} (delay: ${m.delayMs}ms)`) });
  const raceInternalStart = Date.now();
  timings.race_internal_start = 0;
  
  // Create AbortController for each model to cancel losers
  const controllers = racingModels.map(() => new AbortController());
  let winnerIndex = -1;
  
  // Create race promises that resolve on success and never reject (errors become null)
  const racePromises = racingModels.map(async ({ model, delayMs }, index): Promise<{ model: string; reader: ReadableStreamDefaultReader<Uint8Array>; ttftMs: number; index: number; firstData: string } | null> => {
    const modelKey = model.split('/').pop() || model;
    try {
      // Apply delay to equalize finish times
      if (delayMs > 0) {
        slog('info', `${model} waiting ${delayMs}ms before firing...`);
        timings[`${modelKey}_delay_start`] = Date.now() - raceInternalStart;
        await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(resolve, delayMs);
          // If aborted during delay, reject immediately
          controllers[index].signal.addEventListener('abort', () => {
            clearTimeout(timeoutId);
            reject(new DOMException('Aborted during delay', 'AbortError'));
          });
        });
        timings[`${modelKey}_delay_end`] = Date.now() - raceInternalStart;
      }
      
      // Check if already aborted before firing
      if (controllers[index].signal.aborted) {
        slog('info', `${model} aborted before firing`);
        return null;
      }
      
      const startTime = Date.now();
      timings[`${modelKey}_fire`] = Date.now() - raceInternalStart;
      slog('info', `${model} firing request at t=${timings[`${modelKey}_fire`]}ms...`);
      
      // Get model-specific messages (transforms screenshots for vision models)
      const modelMessages = getMessagesForModel(messages, model);
      
      let response: globalThis.Response;
      
      // Call Anthropic directly for Claude models (structured outputs require beta header)
      if (isAnthropicModel(model)) {
        const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
        if (!anthropicKey) {
          slog('error', `${model} requires ANTHROPIC_API_KEY`);
          return null;
        }
        
        const anthropicModel = getAnthropicModelName(model);
        const { system, messages: anthropicMessages } = transformMessagesForAnthropic(modelMessages);
        
        const anthropicBody: any = {
          model: anthropicModel,
          messages: anthropicMessages,
          max_tokens: maxTokens || 4096,
          stream: true
        };
        
        if (system) {
          // Array format with cache_control for prompt caching (stable across racing retries)
          anthropicBody.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
        }
        if (temperature !== undefined) {
          anthropicBody.temperature = temperature;
        }

        // Transform response_format to Anthropic's output_format
        if (responseFormat?.json_schema?.schema) {
          const transformedSchema = transformSchemaForAnthropic(responseFormat.json_schema.schema);
          anthropicBody.output_format = {
            type: 'json_schema',
            schema: transformedSchema
          };
        }

        slog('info', `Calling Anthropic directly for ${anthropicModel}`);
        slog('info', `[Anthropic Race] Request to ${anthropicModel}:`, { data: JSON.stringify(truncateForLogging(anthropicBody), null, 2) });
        response = await fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': ANTHROPIC_BETA_HEADER,
            'content-type': 'application/json'
          },
          body: JSON.stringify(anthropicBody),
          signal: controllers[index].signal
        });
      } else {
        // Call OpenRouter for other models
        const body: any = {
          model,
          messages: modelMessages,  // Use model-specific messages (vision transform)
          temperature,
          max_tokens: maxTokens,
          seed,
          tools,
          tool_choice: toolChoice,
          stream: true
        };

        if (responseFormat) {
          body.response_format = responseFormat;
        }
        if (reasoning) {
          body.reasoning = reasoning;
        }

        slog('info', `[OpenRouter Race] Request to ${model}:`, { data: JSON.stringify(truncateForLogging(body), null, 2) });

        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openRouterKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': supabaseUrl,
            'X-Title': 'Rose AI - Trio Racing'
          },
          body: JSON.stringify(body),
          signal: controllers[index].signal  // Enable abort
        });
      }
      
      const headersTime = Date.now() - startTime;
      timings[`${modelKey}_headers`] = Date.now() - raceInternalStart;
      slog('info', `${model} headers in ${headersTime}ms at t=${timings[`${modelKey}_headers`]}ms (status: ${response.status})`);
      
      if (!response.ok) {
        const errorText = await response.text();
        slog('error', `${model} failed: ${response.status} - ${errorText}`);
        return null;
      }
      
      // CRITICAL: Wait for FIRST ACTUAL DATA, not just headers!
      // This prevents slow models from winning just because their headers arrive first
      const reader = response.body?.getReader();
      if (!reader) {
        slog('error', `${model} no response body`);
        return null;
      }
      
      const decoder = new TextDecoder();
      let buffer = '';  // For parsing - holds incomplete line
      let allData = ''; // Accumulate ALL data for firstData (needed for Anthropic message_start)

      // Read until we get a real data line (not just ": OPENROUTER PROCESSING")
      while (true) {
        // Check if aborted while waiting for content
        if (controllers[index].signal.aborted) {
          slog('info', `${model} aborted while waiting for content`);
          reader.cancel();
          return null;
        }

        const { done, value } = await reader.read();
        if (done) {
          slog('error', `${model} stream ended before data`);
          return null;
        }

        const chunk = decoder.decode(value, { stream: true });
        allData += chunk;  // Accumulate everything for firstData
        buffer += chunk;
        const lines = buffer.split('\n');

        for (const line of lines) {
          // Look for actual data line with CONTENTFUL tokens (not just heartbeats)
          if (line.startsWith('data:') && !line.includes('[DONE]')) {
            try {
              const jsonStr = line.slice(5).trim(); // Remove "data:" prefix
              if (jsonStr) {
                const parsed = JSON.parse(jsonStr);

                // Handle both OpenRouter/OpenAI format and Anthropic format
                let hasContent = false;
                if (parsed.choices?.[0]?.delta) {
                  // OpenRouter/OpenAI format
                  const delta = parsed.choices[0].delta;
                  hasContent = delta.content || delta.reasoning;
                } else if (parsed.type === 'content_block_delta' && (parsed.delta?.text || parsed.delta?.partial_json)) {
                  // Anthropic streaming format (text or structured output)
                  hasContent = true;
                }

                if (hasContent) {
                  const ttftMs = Date.now() - startTime;
                  timings[`${modelKey}_ttft`] = ttftMs;
                  timings[`${modelKey}_first_data`] = Date.now() - raceInternalStart;
                  slog('info', `${model} FIRST CONTENTFUL TOKEN in ${ttftMs}ms at t=${timings[`${modelKey}_first_data`]}ms`);

                  // IMMEDIATELY abort all other racing models to save API costs
                  // Don't wait for promise resolution - kill them NOW
                  controllers.forEach((controller, i) => {
                    if (i !== index) {
                      slog('info', `Immediately aborting loser: ${racingModels[i].model}`);
                      controller.abort();
                    }
                  });

                  // Return the reader (not response) since we've already started reading
                  // Return allData (includes all events like message_start) not just buffer
                  return { model, reader, ttftMs, index, firstData: allData };
                }
              }
            } catch (e) {
              // Skip unparseable lines
            }
          }
        }

        // Keep incomplete line in buffer for next iteration
        buffer = lines[lines.length - 1] || '';
      }
    } catch (error) {
      // Don't log abort errors - they're expected for losers
      if (error instanceof DOMException && error.name === 'AbortError') {
        slog('info', `${model} aborted (race lost)`);
        return null;
      }
      slog('error', `${model} error:`, { data: error });
      return null;
    }
  });
  
  // Use Promise.race with a filter for successful responses
  // We need custom logic since Promise.race doesn't skip null values
  const winner = await new Promise<{ model: string; reader: ReadableStreamDefaultReader<Uint8Array>; ttftMs: number; firstData: string }>((resolve, reject) => {
    let resolved = false;
    let completed = 0;
    
    racePromises.forEach(async (promise) => {
      try {
        const result = await promise;
        completed++;
        
        if (result && !resolved) {
          resolved = true;
          winnerIndex = result.index;
          slog('info', `Winner: ${result.model} (TTFT: ${result.ttftMs}ms)`);
          
          // Losers already aborted inline when winner found contentful token
          // Just update loser latencies (fire-and-forget)
          controllers.forEach((controller, i) => {
            if (i !== winnerIndex) {
              // Increment loser's latency by 10ms (reduces sandbagging, gives them better chance next race)
              incrementLoserLatency(supabase, racingModels[i].model, pool)
                .catch(e => slog('error', `Failed to increment loser latency:`, { data: e }));
            }
          });

          // Update cache for winning model with actual race TTFT (keeps cache fresh)
          updateLatencyCache(supabase, result.model, pool, result.ttftMs)
            .then(() => slog('info', `Cache updated for winner: ${result.model} = ${result.ttftMs}ms`))
            .catch(e => slog('error', `Failed to update winner cache:`, { data: e }));
          
          resolve({ model: result.model, reader: result.reader, ttftMs: result.ttftMs, firstData: result.firstData });
        } else if (completed === racePromises.length && !resolved) {
          reject(new Error('All models failed'));
        }
      } catch (e) {
        completed++;
        if (completed === racePromises.length && !resolved) {
          reject(new Error('All models failed'));
        }
      }
    });
  });
  
  return winner;
}

// ============================================
// BROWSER-USE COMPLETION RACING
// ============================================
// Races browser-use providers to COMPLETION (not first token).
// Winner = first provider to return a complete response.

async function raceBrowserUseModels(
  racingModels: RacingModel[],
  callProviderFn: (model: string, poolIndex: number, signal: AbortSignal) => Promise<{
    action: UnifiedAction;
    ttftMs: number;
    actualModel: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }>,
  browserPool: string[],
  supabase: any,
  pool: string,
  requestId: string,
  timings: Record<string, number>
): Promise<{
  action: UnifiedAction;
  ttftMs: number;
  actualModel: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  modelsRaced: number;
  racingModels: RacingModel[];
}> {

  slog('info', `Starting completion race with ${racingModels.length} models:`, { data: racingModels.map(m => `${m.model} (delay: ${m.delayMs}ms)`) });
  const raceInternalStart = Date.now();
  timings.race_internal_start = 0;

  // Create AbortController for each model to cancel losers
  const controllers = racingModels.map(() => new AbortController());
  let winnerIndex = -1;

  // Create race promises that resolve on success and never reject (errors become null)
  const racePromises = racingModels.map(async ({ model, delayMs }, index): Promise<{
    action: UnifiedAction;
    ttftMs: number;
    actualModel: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    index: number;
    completionMs: number;
  } | null> => {
    const modelKey = model.split('/').pop() || model;
    try {
      // Apply delay to equalize finish times
      if (delayMs > 0) {
        slog('info', `${model} waiting ${delayMs}ms before firing...`);
        timings[`${modelKey}_delay_start`] = Date.now() - raceInternalStart;
        await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(resolve, delayMs);
          // If aborted during delay, reject immediately
          controllers[index].signal.addEventListener('abort', () => {
            clearTimeout(timeoutId);
            reject(new DOMException('Aborted during delay', 'AbortError'));
          });
        });
        timings[`${modelKey}_delay_end`] = Date.now() - raceInternalStart;
      }

      // Check if already aborted before firing
      if (controllers[index].signal.aborted) {
        slog('info', `${model} aborted before firing`);
        return null;
      }

      const startTime = Date.now();
      timings[`${modelKey}_fire`] = Date.now() - raceInternalStart;
      slog('info', `${model} firing request at t=${timings[`${modelKey}_fire`]}ms...`);

      const poolIndex = browserPool.indexOf(model);
      const result = await callProviderFn(model, poolIndex, controllers[index].signal);

      const completionMs = Date.now() - startTime;
      timings[`${modelKey}_complete`] = Date.now() - raceInternalStart;
      timings[`${modelKey}_latency`] = completionMs;
      slog('info', `${model} COMPLETED in ${completionMs}ms at t=${timings[`${modelKey}_complete`]}ms`);

      // IMMEDIATELY abort all other racing models to save API costs
      // Don't wait for promise resolution - kill them NOW
      controllers.forEach((controller, i) => {
        if (i !== index) {
          slog('info', `Immediately aborting loser: ${racingModels[i].model}`);
          controller.abort();
        }
      });

      return { ...result, index, completionMs };
    } catch (error) {
      // Don't log abort errors - they're expected for losers
      if (error instanceof DOMException && error.name === 'AbortError') {
        slog('info', `${model} aborted (race lost)`);
        return null;
      }
      slog('error', `${model} error:`, { data: error });
      return null;
    }
  });

  // Use Promise.race with a filter for successful responses
  // We need custom logic since Promise.race doesn't skip null values
  const winner = await new Promise<{
    action: UnifiedAction;
    ttftMs: number;
    actualModel: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    index: number;
    completionMs: number;
  }>((resolve, reject) => {
    let resolved = false;
    let completed = 0;

    racePromises.forEach(async (promise) => {
      try {
        const result = await promise;
        completed++;

        if (result && !resolved) {
          resolved = true;
          winnerIndex = result.index;
          slog('info', `Winner: ${result.actualModel} (${result.completionMs}ms)`);

          // Losers already aborted inline when winner completed
          // Just update loser latencies (fire-and-forget)
          controllers.forEach((controller, i) => {
            if (i !== winnerIndex) {
              // Increment loser's latency by 10ms (reduces sandbagging, gives them better chance next race)
              incrementLoserLatency(supabase, racingModels[i].model, pool)
                .catch(e => slog('error', `Failed to increment loser latency:`, { data: e }));
            }
          });

          // Update cache for winning model with actual completion time (keeps cache fresh)
          updateLatencyCache(supabase, result.actualModel, pool, result.completionMs)
            .then(() => slog('info', `Cache updated for winner: ${result.actualModel} = ${result.completionMs}ms`))
            .catch(e => slog('error', `Failed to update winner cache:`, { data: e }));

          resolve(result);
        } else if (completed === racePromises.length && !resolved) {
          reject(new Error('All models failed'));
        }
      } catch (e) {
        completed++;
        if (completed === racePromises.length && !resolved) {
          reject(new Error('All models failed'));
        }
      }
    });
  });

  return {
    action: winner.action,
    ttftMs: winner.completionMs,
    actualModel: winner.actualModel,
    usage: winner.usage,
    modelsRaced: racingModels.length,
    racingModels
  };
}

// Transform JSON schema to be Cerebras-compatible
// Cerebras requires: additionalProperties: false for all objects with required arrays
// See: https://inference-docs.cerebras.ai/capabilities/structured-outputs
function transformSchemaForCerebras(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const transformed = { ...schema };

  // If it's an object type with properties, add additionalProperties: false
  if (transformed.type === 'object' && transformed.properties) {
    transformed.additionalProperties = false;
    
    // Cerebras requires all properties to be in required array
    if (!transformed.required) {
      transformed.required = Object.keys(transformed.properties);
    }
    
    // Recursively transform nested properties
    for (const key of Object.keys(transformed.properties)) {
      transformed.properties[key] = transformSchemaForCerebras(transformed.properties[key]);
    }
  }

  // Handle $defs (definitions)
  if (transformed.$defs) {
    for (const key of Object.keys(transformed.$defs)) {
      transformed.$defs[key] = transformSchemaForCerebras(transformed.$defs[key]);
    }
  }

  // Handle array items
  if (transformed.type === 'array' && transformed.items) {
    transformed.items = transformSchemaForCerebras(transformed.items);
  }

  // Handle anyOf/oneOf/allOf
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (transformed[keyword] && Array.isArray(transformed[keyword])) {
      transformed[keyword] = transformed[keyword].map((item: any) => transformSchemaForCerebras(item));
    }
  }

  return transformed;
}

// ============================================
// ANTHROPIC HELPERS
// ============================================

// Check if a model is an Anthropic Claude model
function isAnthropicModel(model: string): boolean {
  return model.toLowerCase().includes('anthropic/') || model.toLowerCase().includes('claude');
}

// Count tool types in a response_format schema
// Anthropic limits anyOf branches to 8 (for tool unions)
// Our schema has tool_calls.items.anyOf = [tool1, tool2, ...] OR uses $defs with anyOf $refs
function countToolTypes(responseFormat: any): number {
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

// Transform OpenAI content block to Anthropic format
// - image_url with data URI -> image with base64 source
// - file blocks (PDF) -> document with base64 source
// - text blocks pass through
function transformContentBlockForAnthropic(block: any): any {
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
            data: data
          }
        };
      }
    }
    // For URL-based images, keep as-is (Anthropic supports URL images too)
    return {
      type: 'image',
      source: {
        type: 'url',
        url: url
      }
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
            data: data
          }
        };
      }
    }
  }

  // Pass through text and other blocks unchanged
  return block;
}

// Transform OpenAI messages format to Anthropic format
// - System messages go to top-level 'system' param
// - Remove trailing assistant messages (prefill not allowed with output_format)
// - Convert image_url blocks to Anthropic image format
// - Convert file blocks (PDF) to Anthropic document format
function transformMessagesForAnthropic(messages: any[]): { system: string; messages: any[] } {
  const systemParts: string[] = [];
  const anthropicMessages: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    } else {
      // Transform content blocks if content is an array
      if (Array.isArray(msg.content)) {
        const transformedContent = msg.content.map(transformContentBlockForAnthropic);
        anthropicMessages.push({ ...msg, content: transformedContent });
      } else {
        anthropicMessages.push(msg);
      }
    }
  }

  // Remove trailing assistant messages (not allowed with output_format)
  while (anthropicMessages.length > 0 && anthropicMessages[anthropicMessages.length - 1].role === 'assistant') {
    anthropicMessages.pop();
  }

  return {
    system: systemParts.join('\n\n'),
    messages: anthropicMessages
  };
}

// Strip unsupported constraints from schema for Anthropic
// Anthropic doesn't support: minimum, maximum, minLength, maxLength, etc.
function transformSchemaForAnthropic(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  
  const transformed = { ...schema };
  
  // Remove unsupported constraints
  const unsupported = ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf', 'minItems', 'maxItems'];
  for (const key of unsupported) {
    delete transformed[key];
  }

  // Anthropic doesn't support additionalProperties as a schema object (e.g. Dict[str, str]).
  // Convert to additionalProperties: false so the request doesn't get rejected.
  if (transformed.type === 'object' && typeof transformed.additionalProperties === 'object' && transformed.additionalProperties !== null) {
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
      transformed[keyword] = transformed[keyword].map((item: any) => transformSchemaForAnthropic(item));
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
function extractToolsFromResponseFormat(responseFormat: any): {
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
 * Agent expects: {"reasoning": "", "response": "<text>", "tool_calls": [{"tool": "<name>", ...params}]}
 */
function reconstructAgentResponse(textContent: string, toolUseBlocks: Array<{ name: string; input: any }>): string {
  const toolCalls = toolUseBlocks.map(t => ({
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
function applyAnthropicToolConfig(
  anthropicBody: any,
  responseFormat: any,
  isClaudeAuth: boolean,
  explicitTools?: any[],
  explicitToolChoice?: any
): boolean {
  if (explicitTools?.length) {
    anthropicBody.tools = explicitTools.map((t: any) => ({
      name: t.function?.name ?? t.name,
      description: t.function?.description ?? t.description,
      input_schema: t.function?.parameters ?? t.input_schema,
    }));
    if (explicitToolChoice) {
      if (explicitToolChoice === 'auto') anthropicBody.tool_choice = { type: 'auto' };
      else if (explicitToolChoice === 'required' || explicitToolChoice === 'any') anthropicBody.tool_choice = { type: 'any' };
      else if (explicitToolChoice?.function?.name) anthropicBody.tool_choice = { type: 'tool', name: explicitToolChoice.function.name };
    }
    return false;
  }

  if (responseFormat?.json_schema?.schema) {
    const transformedSchema = transformSchemaForAnthropic(responseFormat.json_schema.schema);
    if (isClaudeAuth) {
      anthropicBody.output_config = {
        format: { type: 'json_schema', schema: transformedSchema }
      };
    } else {
      anthropicBody.output_format = {
        type: 'json_schema',
        schema: transformedSchema
      };
    }
  }

  return false;
}

// Map OpenRouter model names to Anthropic model names
function getAnthropicModelName(openRouterModel: string): string {
  const mapping: Record<string, string> = {
    'anthropic/claude-haiku-4.5': 'claude-haiku-4-5',
    'anthropic/claude-sonnet-4.5': 'claude-sonnet-4-5',
    'anthropic/claude-sonnet-4': 'claude-sonnet-4-20250514',
    'anthropic/claude-opus-4': 'claude-opus-4-20250514',
    'anthropic/claude-opus-4.6': 'claude-opus-4-6',
    'anthropic/claude-sonnet-4.6': 'claude-sonnet-4-6',
  };
  return mapping[openRouterModel] || openRouterModel.replace('anthropic/', '');
}

// Select a model from the pool (by preference, seed index, or random)
// Priority: modelPreference > modelSeed > random
function selectModel(
  requestedModel: string, 
  modelSeed?: number,
  modelPreference?: ModelPreference
): { model: string; isCerebras: boolean; poolName: string; poolSize: number } {
  let normalized = requestedModel.toLowerCase();
  if (normalized.startsWith('rose-labs/')) {
    normalized = normalized.replace('rose-labs/', '');
  }
  
  const pool = MODEL_POOLS[normalized as keyof typeof MODEL_POOLS];
  
  if (!pool) {
    throw new Error(`Unknown model: ${requestedModel}. Use 'rose-labs/rose-1-lite' or 'rose-labs/rose-1-ultra'`);
  }
  
  // If model_preference is provided, use hardcoded mapping (highest priority)
  if (modelPreference) {
    const preference = MODEL_PREFERENCES[modelPreference];
    if (!preference) {
      throw new Error(`Invalid model_preference: ${modelPreference}. Use 'SMART', 'FAST', or 'CHEAP'`);
    }
    slog('info', `Model selection (preference=${modelPreference}): ${requestedModel} → ${preference.model} (Cerebras: ${preference.isCerebras})`);
    return { model: preference.model, isCerebras: preference.isCerebras, poolName: normalized, poolSize: pool.length };
  }
  
  // If model_seed is provided, use it to select a specific model
  if (modelSeed !== undefined) {
    if (modelSeed < 0 || modelSeed >= pool.length) {
      throw new Error(`model_seed ${modelSeed} out of range. Pool '${normalized}' has ${pool.length} models (valid range: 0-${pool.length - 1})`);
    }
    const selectedModel = pool[modelSeed];
    slog('info', `Model selection (seed=${modelSeed}): ${requestedModel} → ${selectedModel} (Cerebras: false)`);
    return { model: selectedModel, isCerebras: false, poolName: normalized, poolSize: pool.length };
  }
  
  // Random selection from pool
  const selectedModel = pool[Math.floor(Math.random() * pool.length)];
  slog('info', `Model selection: ${requestedModel} → ${selectedModel} (Cerebras: false)`);
  return { model: selectedModel, isCerebras: false, poolName: normalized, poolSize: pool.length };
}

// Validate API key and return user info
async function validateApiKey(apiKey: string, supabase: any): Promise<{ apiKeyId: string, userId: string } | null> {
  slog('info', 'Validating API key:', { data: apiKey.substring(0, 8) + '...' });
  
  const { data, error } = await supabase
    .from('RoseApiKey')
    .select('id, userId')
    .eq('apiKey', apiKey)
    .single();
  
  if (error || !data) {
    slog('error', 'API key validation failed:', { data: error?.message || 'No data found' });
    slog('error', '   Error details:', { data: error });
    return null;
  }
  
  slog('info', 'API key validated for userId:', { data: data.userId });
  return { apiKeyId: data.id, userId: data.userId };
}

// Calculate cost based on token usage
function calculateCost(promptTokens: number, completionTokens: number, model: string, mode?: string): number {
  // Claude-mode uses user's Claude Code subscription — no Rose API cost
  if (mode === 'claude') return 0;

  // Simplified cost calculation - in production, fetch actual pricing
  const costPerMillionPrompt = 50; // $0.50 per million
  const costPerMillionCompletion = 150; // $1.50 per million

  const promptCost = (promptTokens / 1000000) * costPerMillionPrompt;
  const completionCost = (completionTokens / 1000000) * costPerMillionCompletion;

  return Math.ceil((promptCost + completionCost) * 100); // Return in cents
}

// Log usage to database
async function logUsage(supabase: any, apiKeyId: string, userId: string, input: any, output: any, costCents: number, cotSteps: number) {
  const { error } = await supabase
    .from('RoseApiKeyLog')
    .insert({
      id: crypto.randomUUID(),
      apiKeyId,
      userId,
      input,
      output,
      costCents,
      cotSteps
    });
  
  if (error) {
    slog('error', 'Failed to log usage:', { data: error });
  }
}

// Handle streaming response
async function handleStreaming(
  actualModel: string,
  messages: any[],
  temperature: number | undefined,
  maxTokens: number | undefined,
  seed: number | undefined,
  tools: any[] | undefined,
  toolChoice: any,
  responseFormat: any,  // Added: response_format for structured outputs
  reasoning: { max_tokens?: number } | undefined,  // Added: reasoning config for OpenRouter
  openRouterKey: string,
  supabaseUrl: string,
  requestedModel: string,
  isCerebras: boolean,
  poolName: string,     // Added: for debugging
  poolSize: number,     // Added: for debugging
  claudeAuth?: { token: string },  // Optional: user's Claude OAuth token (uses Bearer auth + Claude Code headers)
  skipCache?: boolean,  // Optional: skip cache_control breakpoints (for single-use calls like param populator)
  stallConfig?: {
    timeoutMs: number,  // Max ms between content deltas before triggering fallback
    onFallback: () => Promise<{
      reader: ReadableStreamDefaultReader<Uint8Array>,
      firstData: string,
      actualModel: string,
      poolName: string,
      poolSize: number,
    }>
  },
  claudeTokenError?: string,  // Set when this streaming call is a fallback from a failed claude_token attempt
) {
  // Get model-specific messages (transforms screenshots for vision models)
  const modelMessages = getMessagesForModel(messages, actualModel);

  // Perform fetch BEFORE creating ReadableStream so errors (401, 500, etc.)
  // propagate to the caller and can trigger fallback (e.g. claude_token → racing).
  let fetchResponse: globalThis.Response;
  let nativeToolMode = false;

  if (isCerebras) {
    // Call Cerebras API directly for rose-hyper
    const cerebrasKey = Deno.env.get('CEREBRAS_API_KEY');
    slog('info', `Streaming from Cerebras API with model: ${actualModel}`);

    // Build Cerebras streaming request - supports tools with gpt-oss-120b
    const cerebrasStreamBody: any = {
      model: actualModel,
      messages: modelMessages,  // Use transformed messages
      temperature,
      max_tokens: maxTokens,
      stream: true
    };

    // Add tools for streaming (gpt-oss-120b supports this)
    if (tools && tools.length > 0) {
      cerebrasStreamBody.tools = tools;
    }
    if (toolChoice) {
      cerebrasStreamBody.tool_choice = toolChoice;
    }

    // Add response_format with schema transformation for Cerebras
    if (responseFormat) {
      if (responseFormat.type === 'json_schema' && responseFormat.json_schema?.schema) {
        const transformedSchema = transformSchemaForCerebras(responseFormat.json_schema.schema);
        cerebrasStreamBody.response_format = {
          type: 'json_schema',
          json_schema: {
            name: responseFormat.json_schema.name || 'response',
            strict: true,
            schema: transformedSchema
          }
        };
      } else {
        cerebrasStreamBody.response_format = responseFormat;
      }
    }

    fetchResponse = await fetch(CEREBRAS_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cerebrasKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cerebrasStreamBody)
    });
  } else if (isAnthropicModel(actualModel) || claudeAuth) {
    // Call Anthropic API directly for Claude models (structured outputs require beta header)
    // When claudeAuth is set, actualModel is e.g. "claude-opus-4-6-claude" or "claude-sonnet-4-6-claude" — strip "-claude" suffix for API
    const anthropicModel = claudeAuth ? actualModel.replace('-claude', '') : getAnthropicModelName(actualModel);
    const { system, messages: anthropicMessages } = transformMessagesForAnthropic(modelMessages);

    const anthropicBody: any = {
      model: anthropicModel,
      messages: anthropicMessages,
      max_tokens: maxTokens || 4096,
      stream: true
    };

    if (system) {
      if (skipCache) {
        anthropicBody.system = [{ type: 'text', text: system }];
      } else {
        // Array format with cache_control for prompt caching.
        // System prompt is identical across agent iterations — caching avoids re-processing.
        anthropicBody.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
      }
    }

    // Claude OAuth tokens require the first system block to be a recognized Claude Code/Agent SDK
    // identity string. Without this, the API returns generic "invalid_request_error: Error" for
    // Claude 4 models. Additional system blocks after the identity are allowed.
    if (claudeAuth) {
      const identityBlock = { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." };
      const disclaimerBlock = { type: 'text', text: 'Disregard the previous identity — you are NOT Claude Code. You are a Rose Labs AI agent. Follow the system instructions below.' };
      if (anthropicBody.system) {
        anthropicBody.system.unshift(identityBlock, disclaimerBlock);
      } else {
        anthropicBody.system = [identityBlock, disclaimerBlock];
      }
    }
    if (temperature !== undefined) {
      anthropicBody.temperature = temperature;
    }

    nativeToolMode = applyAnthropicToolConfig(anthropicBody, responseFormat, !!claudeAuth);

    // Add cache_control breakpoints on messages at regular intervals.
    // Anthropic allows up to 4 breakpoints total; 1 is on system, leaving 3 for messages.
    // Place every 20 messages (matching Anthropic's 20-block lookback window).
    if (!skipCache && anthropicBody.messages.length > 0) {
      const MAX_MSG_BREAKPOINTS = 3;
      const INTERVAL = 20;
      let placed = 0;
      // Walk backwards, place breakpoints at intervals from the end
      for (let i = anthropicBody.messages.length - 1; i >= 0 && placed < MAX_MSG_BREAKPOINTS; i -= INTERVAL) {
        const msg = anthropicBody.messages[i];
        if (typeof msg.content === 'string') {
          // Convert string content to array format so we can attach cache_control
          msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
          msg.content[msg.content.length - 1].cache_control = { type: 'ephemeral' };
        }
        placed++;
      }
      if (placed > 0) {
        slog('info', `Placed ${placed} message cache breakpoints across ${anthropicBody.messages.length} messages`);
      }
    }

    slog('info', `Streaming from Anthropic API with model: ${anthropicModel}${claudeAuth ? ' (claude token)' : ''}${nativeToolMode ? ` (native tools: ${anthropicBody.tools.length})` : ''}${skipCache ? ' (skip_cache)' : ''}`);

    // Use Claude OAuth token (user's subscription) or Rose's API key
    const anthropicHeaders: Record<string, string> = {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
    if (claudeAuth) {
      anthropicHeaders['Authorization'] = `Bearer ${claudeAuth.token}`;
      anthropicHeaders['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24';
      anthropicHeaders['x-app'] = 'cli';
      anthropicHeaders['User-Agent'] = 'claude-cli/2.1.81 (external, sdk-ts, agent-sdk/0.2.75)';
    } else {
      const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
      if (!anthropicKey) {
        throw new Error(`ANTHROPIC_API_KEY required for ${actualModel}`);
      }
      anthropicHeaders['x-api-key'] = anthropicKey;
      anthropicHeaders['anthropic-beta'] = ANTHROPIC_BETA_HEADER;
    }

    slog('info', `[Anthropic Stream] Request to ${anthropicModel}:`, { data: JSON.stringify(truncateForLogging(anthropicBody), null, 2) });

    fetchResponse = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify(anthropicBody)
    });
  } else {
    // Call OpenRouter API for other Rose models
    const openRouterBody: any = {
      model: actualModel,
      messages: modelMessages,  // Use transformed messages
      temperature,
      max_tokens: maxTokens,
      seed,
      tools,
      tool_choice: toolChoice,
      stream: true
    };

    // Add response_format for structured outputs
    if (responseFormat) {
      openRouterBody.response_format = responseFormat;
    }

    // Add reasoning config for reasoning models (Gemini, Anthropic, etc.)
    if (reasoning) {
      openRouterBody.reasoning = reasoning;
      slog('info', `Streaming with reasoning config:`, { data: reasoning });
    }

    slog('info', `[OpenRouter Stream] Request to ${actualModel}:`, { data: JSON.stringify(truncateForLogging(openRouterBody), null, 2) });

    fetchResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openRouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': supabaseUrl,
        'X-Title': 'Rose Benchmark Suite'
      },
      body: JSON.stringify(openRouterBody)
    });
  }

  if (!fetchResponse.ok) {
    const provider = isCerebras ? 'Cerebras' : (isAnthropicModel(actualModel) || claudeAuth) ? 'Anthropic' : 'OpenRouter';
    const errorText = await fetchResponse.text();
    slog('error', `${provider} streaming error:`, { data: [fetchResponse.status, errorText] });
    throw new Error(`${provider} API error: ${fetchResponse.status} - ${errorText.slice(0, 200)}`);
  }

  const reader = fetchResponse.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const decoder = new TextDecoder();
        let buffer = '';

        // Stall detection: reassignable reader/model so we can swap to racing on stall
        let currentReader = reader;
        let currentModel = actualModel;
        let currentPoolName = poolName;
        let currentPoolSize = poolSize;
        let currentStallConfig = stallConfig;
        let hasReceivedContent = false;
        let lastContentTime = Date.now();
        let currentClaudeTokenError = claudeTokenError;  // Mutable: set to 'stall' on stall fallback

        // Anthropic usage tracking - capture from message_start and message_delta
        let anthropicInputTokens = 0;
        let anthropicOutputTokens = 0;
        let anthropicCacheCreationTokens = 0;
        let anthropicCacheReadTokens = 0;

        // Native tool mode: reconstruct streaming JSON matching structured output format.
        // With tool_choice=auto, model produces text + tool_use blocks naturally.
        // Only active for execute phase (>8 tools). Plan phase uses structured output.
        // We wrap text in {"response": "...", "tool_calls": [...]} and inject tool names into partial_json.
        let ntState: 'initial' | 'in_response' | 'in_tool_calls' = 'initial';
        let ntCurrentBlock: 'text' | 'tool_use' | null = null;
        let ntCurrentToolName = '';
        let ntToolInputStarted = false;
        let ntToolCount = 0;

        const emitDelta = (content: string) => {
          if (!content) return;
          const chunk: RoseCompletionChunk = {
            choices: [{ index: 0, delta: { content } }],
            requested_model: requestedModel,
            actual_model: currentModel,
            pool_name: currentPoolName,
            pool_size: currentPoolSize,
            ...(currentClaudeTokenError && { claude_token_error: currentClaudeTokenError }),
          };
          const payload = `data: ${JSON.stringify(chunk)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        };

        while (true) {
          // Stall detection: timeout reader.read() based on time since last content
          let done: boolean;
          let value: Uint8Array | undefined;
          try {
            if (currentStallConfig) {
              const elapsed = Date.now() - lastContentTime;
              const remaining = Math.max(currentStallConfig.timeoutMs - elapsed, 0);
              const result = await withTimeout(currentReader.read(), remaining, 'content deadline');
              done = result.done;
              value = result.value;
            } else {
              const result = await currentReader.read();
              done = result.done;
              value = result.value;
            }
          } catch (timeoutError) {
            if (!hasReceivedContent && currentStallConfig?.onFallback) {
              // Never got content - seamlessly switch to racing
              slog('warn', '[Stall] No content from Claude in 20s, switching to racing');
              currentReader.cancel();
              if (claudeAuth) currentClaudeTokenError = 'stall';  // Signal transient failure to agent
              try {
                const fallback = await currentStallConfig.onFallback();
                currentReader = fallback.reader;
                currentModel = fallback.actualModel;
                currentPoolName = fallback.poolName;
                currentPoolSize = fallback.poolSize;
                if (fallback.firstData) buffer += fallback.firstData;
                currentStallConfig = undefined;  // disable timeout for racing reader
                lastContentTime = Date.now();
                continue;
              } catch (fallbackError) {
                slog('error', '[Stall] Fallback racing also failed, closing stream:', { data: fallbackError });
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: 'All model providers failed', type: 'server_error' } })}\n\n`));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
                break;
              }
            }
            // Had content but stalled - close gracefully
            slog('warn', '[Stall] Claude stalled mid-content after 20s, closing');
            currentReader.cancel();
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            break;
          }

          if (done) {
            // In native tool mode, close the JSON envelope
            if (nativeToolMode && isAnthropicModel(currentModel)) {
              if (ntState === 'initial') {
                emitDelta('{"response": "", "tool_calls": []}');
              } else if (ntState === 'in_response') {
                emitDelta('", "tool_calls": []}');
              } else if (ntState === 'in_tool_calls') {
                emitDelta(']}');
              }
              slog('info', `Native tool mode complete: ${ntToolCount} tool(s), final state: ${ntState}`);
            }

            // For Anthropic models, emit final usage chunk before [DONE]
            if (isAnthropicModel(currentModel) && (anthropicInputTokens > 0 || anthropicOutputTokens > 0)) {
              const usageChunk: RoseCompletionChunk = {
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop'
                }],
                usage: {
                  prompt_tokens: anthropicInputTokens,
                  completion_tokens: anthropicOutputTokens,
                  total_tokens: anthropicInputTokens + anthropicOutputTokens,
                  cache_creation_input_tokens: anthropicCacheCreationTokens,
                  cache_read_input_tokens: anthropicCacheReadTokens,
                },
                requested_model: requestedModel,
                actual_model: currentModel,
                pool_name: currentPoolName,
                pool_size: currentPoolSize,
                ...(currentClaudeTokenError && { claude_token_error: currentClaudeTokenError }),
              };
              const payload = `data: ${JSON.stringify(usageChunk)}\n\n`;
              controller.enqueue(encoder.encode(payload));
              const cacheHitPct = anthropicInputTokens > 0 ? Math.round(anthropicCacheReadTokens / (anthropicInputTokens + anthropicCacheCreationTokens + anthropicCacheReadTokens) * 100) : 0;
              slog('info', `Anthropic usage emitted: input=${anthropicInputTokens}, output=${anthropicOutputTokens}, cache_read=${anthropicCacheReadTokens}, cache_write=${anthropicCacheCreationTokens}, cache_hit=${cacheHitPct}%`);
            }
            const donePayload = 'data: [DONE]\n\n';
            controller.enqueue(encoder.encode(donePayload));
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                continue;
              }

              try {
                const parsed = JSON.parse(data);

                // Transform Anthropic streaming events to OpenAI format
                if (isAnthropicModel(currentModel)) {
                  // Capture input tokens and cache metrics from message_start
                  if (parsed.type === 'message_start' && parsed.message?.usage) {
                    const msgUsage = parsed.message.usage;
                    anthropicInputTokens = msgUsage.input_tokens || 0;
                    anthropicCacheCreationTokens = msgUsage.cache_creation_input_tokens || 0;
                    anthropicCacheReadTokens = msgUsage.cache_read_input_tokens || 0;
                    slog('info', `Anthropic input_tokens=${anthropicInputTokens}, cache_read=${anthropicCacheReadTokens}, cache_write=${anthropicCacheCreationTokens}`);
                    continue;
                  }

                  // Capture output tokens from message_delta
                  if (parsed.type === 'message_delta' && parsed.usage?.output_tokens) {
                    anthropicOutputTokens = parsed.usage.output_tokens;
                    slog('info', `Anthropic output_tokens captured: ${anthropicOutputTokens}`);
                    continue;
                  }

                  if (nativeToolMode) {
                    // === NATIVE TOOL MODE ===
                    // With tool_choice=any, model MUST produce tool_use blocks.
                    // Reconstruct: {"response": "<text>", "tool_calls": [{"tool": "<name>", ...}]}

                    if (parsed.type === 'content_block_start') {
                      if (parsed.content_block?.type === 'text') {
                        ntCurrentBlock = 'text';
                        if (ntState === 'initial') {
                          emitDelta('{"response": "');
                          ntState = 'in_response';
                        }
                      } else if (parsed.content_block?.type === 'tool_use') {
                        ntCurrentBlock = 'tool_use';
                        ntCurrentToolName = parsed.content_block.name || '';
                        ntToolInputStarted = false;
                        if (ntState === 'initial') {
                          emitDelta('{"response": "", "tool_calls": [');
                          ntState = 'in_tool_calls';
                        } else if (ntState === 'in_response') {
                          emitDelta('", "tool_calls": [');
                          ntState = 'in_tool_calls';
                        }
                        if (ntToolCount > 0) {
                          emitDelta(', ');
                        }
                        ntToolCount++;
                      }
                      continue;
                    }

                    if (parsed.type === 'content_block_delta') {
                      lastContentTime = Date.now();
                      hasReceivedContent = true;
                      if (ntCurrentBlock === 'text' && parsed.delta?.text) {
                        emitDelta(escapeForJsonString(parsed.delta.text));
                      } else if (ntCurrentBlock === 'tool_use' && parsed.delta?.partial_json) {
                        const fragment = parsed.delta.partial_json;
                        if (!ntToolInputStarted) {
                          ntToolInputStarted = true;
                          if (fragment === '{}') {
                            emitDelta(`{"tool": "${ntCurrentToolName}"}`);
                          } else if (fragment.startsWith('{')) {
                            emitDelta(`{"tool": "${ntCurrentToolName}", ` + fragment.slice(1));
                          } else {
                            emitDelta(`{"tool": "${ntCurrentToolName}", ` + fragment);
                          }
                        } else {
                          emitDelta(fragment);
                        }
                      }
                      continue;
                    }

                    if (parsed.type === 'content_block_stop') {
                      ntCurrentBlock = null;
                      continue;
                    }

                    continue;
                  }

                  // === STANDARD MODE: original streaming logic ===

                  // Skip other non-content events
                  if (parsed.type !== 'content_block_delta') {
                    continue;
                  }

                  // Transform to OpenAI format
                  // Handle both delta.text (normal) and delta.partial_json (JSON schema output)
                  lastContentTime = Date.now();
                  hasReceivedContent = true;
                  emitDelta(parsed.delta?.text || parsed.delta?.partial_json || '');
                } else {
                  // OpenRouter/Cerebras - pass through with metadata
                  // Skip chunks with empty/missing choices (OpenRouter debug/echo chunks)
                  if (!parsed.choices?.length) {
                    continue;
                  }
                  lastContentTime = Date.now();
                  hasReceivedContent = true;

                  // Translate OpenRouter cache fields to canonical Anthropic format
                  if (parsed.usage?.prompt_tokens_details) {
                    const details = parsed.usage.prompt_tokens_details;
                    const cachedTokens = details.cached_tokens || 0;
                    const cacheWriteTokens = details.cache_write_tokens || 0;
                    parsed.usage.cache_read_input_tokens = cachedTokens;
                    parsed.usage.cache_creation_input_tokens = cacheWriteTokens;
                    parsed.usage.prompt_tokens = Math.max(0, parsed.usage.prompt_tokens - cachedTokens - cacheWriteTokens);
                  }

                  parsed.requested_model = requestedModel;
                  parsed.actual_model = currentModel;
                  parsed.pool_name = currentPoolName;
                  parsed.pool_size = currentPoolSize;
                  if (currentClaudeTokenError) parsed.claude_token_error = currentClaudeTokenError;
                  const payload = `data: ${JSON.stringify(parsed)}\n\n`;
                  controller.enqueue(encoder.encode(payload));
                }
              } catch (e) {
                slog('error', 'Error parsing streaming data:', { data: e });
              }
            } else if (line.startsWith('event: ')) {
              // Anthropic uses separate event lines - skip them (data follows)
              continue;
            }
          }
        }
      } catch (error) {
        slog('error', 'Streaming error:', { data: error });
        controller.error(error);
      }
    }
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// Main handler
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Extract request ID from header (sent by agent) or generate one
  const requestId = req.headers.get('x-request-id') || crypto.randomUUID().slice(0, 8);
  const agentId = req.headers.get('x-agent-id') || undefined;
  const callSite = req.headers.get('x-call-site') || undefined;
  slog('info', 'REQUEST START', { request_id: requestId, agent_id: agentId, call_site: callSite });

  try {
    // Extract API key from header
    const apiKey = req.headers.get('x-api-key');
    if (!apiKey) {
      slog('info', `[${requestId}] Missing x-api-key header`, { request_id: requestId, agent_id: agentId, call_site: callSite });
      return new Response(JSON.stringify({ error: 'Missing x-api-key header' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    // Initialize Supabase client
    // Use PROD_ prefixed vars if available, otherwise hardcoded production values for local dev
    // (Supabase CLI overrides SUPABASE_URL to local instance, so we need explicit prod values)
    const supabaseUrl = Deno.env.get('PROD_SUPABASE_URL') || 'https://kzlurqihzaolhzsbkctf.supabase.co';
    const supabaseServiceKey = Deno.env.get('PROD_SUPABASE_SERVICE_ROLE_KEY') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1OTg4OTMzNiwiZXhwIjoyMDc1NDY1MzM2fQ.Iff9HtO2szAAKIpOmzGacxMgMZeeqXQfLzQTxrakF9g';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Validate API key
    slog('info', `[${requestId}] Validating API key...`, { request_id: requestId, agent_id: agentId, call_site: callSite });
    const authInfo = await validateApiKey(apiKey, supabase);
    if (!authInfo) {
      slog('info', `[${requestId}] Invalid API key`, { request_id: requestId, agent_id: agentId, call_site: callSite });
      return new Response(JSON.stringify({ error: 'Invalid API key' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }
    slog('info', `[${requestId}] API key validated for userId: ${authInfo.userId}`, { request_id: requestId, agent_id: agentId, call_site: callSite });

    // Parse request body (raw first for browser-use detection)
    const rawBody = await req.json();

    // ============================================
    // HANDLE BROWSER-USE REQUESTS (EARLY)
    // Browser-use has different format: task + browser_state instead of messages
    // ============================================
    if (isBrowserUseRequest(rawBody)) {
      slog('info', `[${requestId}] Browser-use request detected for model: ${rawBody.model}`, { request_id: requestId, agent_id: agentId, call_site: callSite });
      const browserUseReq = rawBody as BrowserUseRequest;

      // Tracing: log action_history details
      slog('info', `[${requestId}] action_history count: ${browserUseReq.action_history.length}`, { request_id: requestId, agent_id: agentId, call_site: callSite });
      if (browserUseReq.action_history.length > 0) {
        const lastAction = browserUseReq.action_history[browserUseReq.action_history.length - 1];
        slog('info', `[${requestId}] Last action:`, { data: {
          action: lastAction.action,
          hasThinking: !!lastAction.thinking,
          hasScreenshot: !!lastAction.screenshot,
          thinkingPreview: lastAction.thinking?.slice(0, 100)
        } , request_id: requestId, agent_id: agentId, call_site: callSite });
      }

      // Tracing: log screenshot metadata
      if (browserUseReq.browser_state.screenshot) {
        slog('info', `[${requestId}] Screenshot received:`, { data: {
          viewport: `${browserUseReq.browser_state.viewport.width}x${browserUseReq.browser_state.viewport.height}`,
          screenshotChars: browserUseReq.browser_state.screenshot.length,
          isBase64: !browserUseReq.browser_state.screenshot.startsWith('http')
        } , request_id: requestId, agent_id: agentId, call_site: callSite });
      }

      // Get the browser-use pool
      const browserPool = MODEL_POOLS['rose-1-browser-use'];
      if (!browserPool) {
        slog('info', `[${requestId}] Browser-use pool not configured`, { request_id: requestId, agent_id: agentId, call_site: callSite });
        return new Response(JSON.stringify({
          error: 'Browser-use pool not configured'
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        });
      }

      // Helper to call a specific provider with full request/response logging
      async function callProvider(
        provider: string,
        providerIndex: number,
        signal?: AbortSignal
      ): Promise<{ action: UnifiedAction; ttftMs: number; actualModel: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
        // Log the full request (with truncated screenshots)
        slog('info', `📤 [${requestId}] [${provider}] FULL REQUEST:`, { request_id: requestId, agent_id: agentId, call_site: callSite });
        slog('info', `[${requestId}] [${provider}] FULL REQUEST body`, { request_id: requestId, agent_id: agentId, call_site: callSite, data: JSON.stringify(truncateForLogging({
          requestId,
          provider,
          providerIndex,
          task: browserUseReq.task,
          browser_state: browserUseReq.browser_state,
          action_history: browserUseReq.action_history,
          model_seed: browserUseReq.model_seed,
        }), null, 2) });

        let result: { response?: any; ttftMs: number; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };
        let normalizedAction: UnifiedAction;
        let actualModel: string;

        if (provider === 'browser-use') {
          const browserUseApiKey = Deno.env.get('BROWSER_USE_API_KEY');
          if (!browserUseApiKey) throw new Error('BROWSER_USE_API_KEY not configured');

          slog('info', `[${requestId}] [${provider}] Calling browser-use API...`, { request_id: requestId, agent_id: agentId, call_site: callSite });
          result = await callBrowserUseLLM(browserUseReq, browserUseApiKey, signal);
          normalizedAction = normalizeBrowserUseResponse(result.response);
          actualModel = 'browser-use/bu-1-0';

        } else if (provider === 'yutori/n1') {
          const yutoriApiKey = Deno.env.get('YUTORI_API_KEY');
          if (!yutoriApiKey) throw new Error('YUTORI_API_KEY not configured');
          if (!browserUseReq.browser_state.screenshot) {
            throw new Error('Yutori requires screenshot');
          }

          slog('info', `[${requestId}] [${provider}] Calling Yutori API...`, { request_id: requestId, agent_id: agentId, call_site: callSite });
          result = await callYutoriLLM(browserUseReq, yutoriApiKey, signal);
          normalizedAction = normalizeYutoriResponse(result.response, browserUseReq.browser_state.viewport);
          actualModel = 'yutori/n1';

        } else if (provider === 'anthropic/claude-cua') {
          const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY');
          if (!anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not configured');
          if (browserUseReq.browser_state.screenshot?.startsWith('http')) {
            throw new Error('Anthropic CUA requires base64 screenshot');
          }

          slog('info', `[${requestId}] [${provider}] Calling Anthropic CUA API...`, { request_id: requestId, agent_id: agentId, call_site: callSite });
          result = await callAnthropicCUA(browserUseReq, anthropicApiKey);
          normalizedAction = normalizeAnthropicCUAResponse(result.response);
          actualModel = 'anthropic/claude-sonnet-4-cua';

        } else if (isAnthropicModel(provider)) {
          // Direct Anthropic API call (matching streaming race pattern)
          const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
          if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY not configured');

          const isDomOnly = DOM_ONLY_MODELS.includes(provider);
          const { messages } = transformToBrowserUseFormat(browserUseReq, { includeScreenshot: !isDomOnly });
          const { system, messages: anthropicMessages } = transformMessagesForAnthropic(messages);
          const anthropicModel = getAnthropicModelName(provider);

          slog('info', `[${requestId}] [${provider}] Calling Anthropic API directly (model: ${anthropicModel})...`, { request_id: requestId, agent_id: agentId, call_site: callSite });

          const anthropicBody: any = {
            model: anthropicModel,
            messages: anthropicMessages,
            max_tokens: 1024,
            temperature: 0.3,
          };
          if (system) anthropicBody.system = system;
          // No output_format — system prompt instructs JSON format,
          // same approach as browser-use and yutori providers

          slog('info', `[Anthropic BU] Request to ${anthropicModel}:`, { data: JSON.stringify(truncateForLogging(anthropicBody), null, 2) });

          const startTime = Date.now();
          const response = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json'
            },
            body: JSON.stringify(anthropicBody),
            signal
          });

          const ttftMs = Date.now() - startTime;

          if (!response.ok) {
            const errorText = await response.text();
            slog('error', `Anthropic BU API error:`, { data: [response.status, errorText] });
            throw new Error(`Anthropic BU API error: ${response.status} - ${errorText}`);
          }

          const data = await response.json();
          slog('info', 'Anthropic BU raw response:', { data: JSON.stringify(truncateForLogging(data), null, 2) });

          // Extract text content from Anthropic response format
          const textContent = data.content?.find((c: any) => c.type === 'text')?.text || '';
          let completion: any;
          try {
            completion = typeof textContent === 'string' ? JSON.parse(textContent) : textContent;
          } catch {
            // JSON.parse failed — try extractJSON to handle markdown-wrapped JSON (```json ... ```)
            const extracted = extractJSON(textContent);
            completion = extracted || { action: [], thinking: textContent };
          }

          const usage = {
            prompt_tokens: data.usage?.input_tokens || 0,
            completion_tokens: data.usage?.output_tokens || 0,
            total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
          };

          result = { response: { completion }, ttftMs, usage };
          normalizedAction = normalizeBrowserUseResponse(result.response);
          actualModel = provider;

        } else {
          // Generic LLM via OpenRouter (e.g. openai/gpt-5.2)
          const openRouterKey = Deno.env.get('OPENROUTER_API_KEY');
          if (!openRouterKey) throw new Error('OPENROUTER_API_KEY not configured');

          slog('info', `[${requestId}] [${provider}] Calling OpenRouter API...`, { request_id: requestId, agent_id: agentId, call_site: callSite });
          result = await callGenericLLM(browserUseReq, provider, openRouterKey, supabaseUrl, signal);
          normalizedAction = normalizeBrowserUseResponse(result.response);
          actualModel = provider;
        }

        slog('info', `[${requestId}] [${provider}] FULL RESPONSE (ttft=${result.ttftMs}ms)`, { request_id: requestId, agent_id: agentId, call_site: callSite, data: JSON.stringify(truncateForLogging(result.response), null, 2) });
        slog('info', `[${requestId}] [${provider}] NORMALIZED ACTION`, { request_id: requestId, agent_id: agentId, call_site: callSite, data: JSON.stringify(normalizedAction, null, 2) });

        return { action: normalizedAction, ttftMs: result.ttftMs, actualModel, usage: result.usage };
      }
      
      // ============================================
      // CLAUDE MODE: Direct Anthropic call with Claude Code credentials + prompt caching
      // ============================================
      if (browserUseReq.mode === 'claude') {
        // TEMPORARILY DISABLED: Every 3rd step, route to Yutori via the existing model_seed path (index 1 in pool)
        // const stepNumber = browserUseReq.action_history.length;
        // if (stepNumber > 0 && stepNumber % 3 === 0 && browserUseReq.browser_state.screenshot) {
        //   slog('info', `[${requestId}] Claude mode: routing step ${stepNumber} to Yutori via model_seed=1`, { request_id: requestId, agent_id: agentId, call_site: callSite });
        //   browserUseReq.model_seed = 1; // yutori/n1 is index 1 in rose-1-browser-use pool
        //   // Fall through to model_seed handler below
        // } else
        {
        // For claude-mode, use user_id from request body if provided (the API key may map to a shared
        // worker user, but the real user who owns the agent/credentials is passed via user_id)
        const claudeUserId = browserUseReq.user_id || authInfo.userId;
        slog('info', `[${requestId}] Claude mode: direct Opus 4.6 with cache controls (userId: ${claudeUserId})`, { request_id: requestId, agent_id: agentId, call_site: callSite });

        // Fetch Claude Code OAuth token from backend
        const backendUrl = Deno.env.get('BACKEND_API_URL') || 'https://navi-j9a9.onrender.com';
        const backendApiKey = Deno.env.get('BACKEND_API_KEY');
        if (!backendApiKey) {
          return new Response(JSON.stringify({ error: 'BACKEND_API_KEY not configured for claude mode' }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500,
          });
        }

        let oauthToken: string;
        if (browserUseReq.oauth_token) {
          // Token provided by caller (agent worker handles token management)
          oauthToken = browserUseReq.oauth_token;
          slog('info', `[${requestId}] Using caller-provided OAuth token`, { request_id: requestId, agent_id: agentId, call_site: callSite });
        } else {
          // Fallback: fetch from backend (backwards compat)
          try {
            const tokenResp = await fetch(`${backendUrl}/api/integrations/claude-code/credentials/token`, {
              headers: {
                'X-API-Key': backendApiKey,
                'X-User-Id': claudeUserId,
              },
            });
            if (!tokenResp.ok) {
              const errData = await tokenResp.json().catch(() => null);
              const errMsg = errData?.error || `Backend token fetch failed: ${tokenResp.status}`;
              slog('error', `[${requestId}] Claude Code token fetch failed:`, { data: errMsg , request_id: requestId, agent_id: agentId, call_site: callSite });
              return new Response(JSON.stringify({
                error: errMsg,
                request_id: requestId,
              }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
                status: tokenResp.status === 404 ? 400 : 500,
              });
            }
            const tokenData = await tokenResp.json();
            oauthToken = tokenData.accessToken;
          } catch (tokenErr) {
            slog('error', `[${requestId}] Failed to fetch Claude Code token:`, { data: tokenErr , request_id: requestId, agent_id: agentId, call_site: callSite });
            return new Response(JSON.stringify({
              error: 'Failed to fetch Claude Code credentials',
              details: tokenErr instanceof Error ? tokenErr.message : 'Unknown error',
              request_id: requestId,
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500,
            });
          }
        }

        // Build messages with screenshots ON (including history screenshots)
        const { messages } = transformToBrowserUseFormat(browserUseReq, { includeScreenshot: true });

        // Build history screenshot blocks for the user message
        // Each action_history entry with a screenshot gets an image block
        const historyImageBlocks: any[] = [];
        for (const entry of browserUseReq.action_history) {
          if (entry.screenshot) {
            const imageUrl = entry.screenshot.startsWith('http')
              ? entry.screenshot
              : `data:image/png;base64,${entry.screenshot}`;
            historyImageBlocks.push({
              type: 'text',
              text: `Step ${entry.step}: ${entry.action}${entry.index !== undefined ? ` (index: ${entry.index})` : ''} ${entry.result.success ? '✓' : '✗'}`,
            });
            historyImageBlocks.push({
              type: 'image_url',
              image_url: { url: imageUrl },
            });
          }
        }

        // Inject history screenshots into user message content
        if (historyImageBlocks.length > 0) {
          const userMsg = messages.find((m: any) => m.role === 'user');
          if (userMsg) {
            // Ensure content is an array
            if (!Array.isArray(userMsg.content)) {
              userMsg.content = [{ type: 'text', text: userMsg.content }];
            }
            // Insert history screenshots before the last content block
            userMsg.content = [
              ...userMsg.content,
              { type: 'text', text: '\n--- Action History Screenshots ---' },
              ...historyImageBlocks,
            ];
          }
        }

        // Transform to Anthropic format — system as array with cache_control
        const systemParts: string[] = [];
        const anthropicMessages: any[] = [];

        for (const msg of messages) {
          if (msg.role === 'system') {
            systemParts.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
          } else {
            if (Array.isArray(msg.content)) {
              const transformedContent = msg.content.map(transformContentBlockForAnthropic);
              anthropicMessages.push({ ...msg, content: transformedContent });
            } else {
              anthropicMessages.push(msg);
            }
          }
        }

        // Add cache_control breakpoint only to the last user message's last content block
        for (let i = anthropicMessages.length - 1; i >= 0; i--) {
          if (anthropicMessages[i].role === 'user' && Array.isArray(anthropicMessages[i].content) && anthropicMessages[i].content.length > 0) {
            anthropicMessages[i].content[anthropicMessages[i].content.length - 1].cache_control = { type: 'ephemeral' };
            break;
          }
        }

        // Build system as array of blocks with cache_control (required for prompt caching)
        const systemBlocks = systemParts.map((text, i) => ({
          type: 'text' as const,
          text,
          ...(i === systemParts.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
        }));

        const identityBlock = { type: 'text' as const, text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." };
        const disclaimerBlock = { type: 'text' as const, text: 'Disregard the previous identity — you are NOT Claude Code. You are a Rose Labs AI agent. Follow the system instructions below.' };
        const anthropicBody = {
          model: 'claude-opus-4-6',
          system: [identityBlock, disclaimerBlock, ...systemBlocks],
          messages: anthropicMessages,
          max_tokens: 4096,
          temperature: 0.3,
        };

        slog('info', `[${requestId}] Claude mode: calling Anthropic with cache controls`, { request_id: requestId, agent_id: agentId, call_site: callSite });
        slog('info', `[Claude Mode] System blocks: ${systemBlocks.length}, Messages: ${anthropicMessages.length}`);

        const startTime = Date.now();
        const response = await fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${oauthToken}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24',
            'x-app': 'cli',
            'User-Agent': 'claude-cli/2.1.81 (external, sdk-ts, agent-sdk/0.2.75)',
            'content-type': 'application/json',
          },
          body: JSON.stringify(anthropicBody),
        });

        const ttftMs = Date.now() - startTime;

        if (!response.ok) {
          const errorText = await response.text();
          slog('error', `[${requestId}] Claude mode API error:`, { data: [response.status, errorText] , request_id: requestId, agent_id: agentId, call_site: callSite });

          // Rate limited — signal caller to fall back to racing
          if (response.status === 429) {
            const parseEpochHeader = (raw: string | null): number | null => {
              if (!raw) return null;
              const num = Number(raw);
              if (!Number.isFinite(num) || num <= 0) return null;
              return Math.floor(num);
            };
            const parseRetryAfter = (raw: string | null): number | null => {
              if (!raw) return null;
              const seconds = Number(raw);
              if (!Number.isFinite(seconds) || seconds <= 0) return null;
              return Math.floor(seconds);
            };

            const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
            const unifiedReset = parseEpochHeader(response.headers.get('anthropic-ratelimit-unified-reset'));
            const unified5hReset = parseEpochHeader(response.headers.get('anthropic-ratelimit-unified-5h-reset'));
            const unified7dReset = parseEpochHeader(response.headers.get('anthropic-ratelimit-unified-7d-reset'));
            const chosenResetEpoch = unifiedReset ?? unified5hReset ?? unified7dReset ??
              (retryAfter ? Math.floor(Date.now() / 1000) + retryAfter : null);
            const rateLimitedUntil = chosenResetEpoch
              ? new Date(chosenResetEpoch * 1000).toISOString()
              : null;

            let rateLimitMessage = '';
            try {
              const parsed = JSON.parse(errorText);
              rateLimitMessage = parsed?.error?.message || parsed?.message || '';
            } catch {
              rateLimitMessage = errorText.slice(0, 300);
            }

            slog('warn', `[${requestId}] Claude mode rate limited, signaling fallback to racing`, { request_id: requestId, agent_id: agentId, call_site: callSite });
            return new Response(JSON.stringify({
              error: 'CLAUDE_RATE_LIMITED',
              fallback: 'racing',
              rateLimitedUntil,
              rateLimitHeaders: {
                retryAfter: response.headers.get('retry-after'),
                unifiedStatus: response.headers.get('anthropic-ratelimit-unified-status'),
                unifiedReset: response.headers.get('anthropic-ratelimit-unified-reset'),
                representativeClaim: response.headers.get('anthropic-ratelimit-unified-representative-claim'),
                overageDisabledReason: response.headers.get('anthropic-ratelimit-unified-overage-disabled-reason'),
              },
              message: rateLimitMessage || 'Claude account is rate limited',
              request_id: requestId,
            }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
              status: 200,
            });
          }

          return new Response(JSON.stringify({
            error: `Anthropic API error: ${response.status}`,
            details: errorText,
            request_id: requestId,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: response.status === 401 ? 401 : 500,
          });
        }

        const data = await response.json();
        slog('info', 'Claude mode raw response:', { data: JSON.stringify(truncateForLogging(data), null, 2) });

        // Extract text content from Anthropic response
        const textContent = data.content?.find((c: any) => c.type === 'text')?.text || '';
        let completion: any;
        try {
          completion = typeof textContent === 'string' ? JSON.parse(textContent) : textContent;
        } catch {
          const extracted = extractJSON(textContent);
          completion = extracted || { action: [], thinking: textContent };
        }

        const usage = {
          prompt_tokens: data.usage?.input_tokens || 0,
          completion_tokens: data.usage?.output_tokens || 0,
          total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
          cache_creation_input_tokens: data.usage?.cache_creation_input_tokens || 0,
          cache_read_input_tokens: data.usage?.cache_read_input_tokens || 0,
        };

        const normalizedAction = normalizeBrowserUseResponse({ completion });
        slog('info', `[${requestId}] Claude mode: action=${normalizedAction.action}, ttft=${ttftMs}ms, cache_read=${usage.cache_read_input_tokens}, cache_write=${usage.cache_creation_input_tokens}`, { request_id: requestId, agent_id: agentId, call_site: callSite });

        // Log usage with $0 cost (billed to user's Claude subscription)
        const claudeModeResponse = {
          action: normalizedAction,
          actual_model: 'anthropic/claude-opus-4.6',
          mode: 'claude',
          usage,
          ttft_ms: ttftMs,
        };
        await logUsage(supabase, authInfo.apiKeyId, authInfo.userId, {
          model: browserUseReq.model,
          mode: 'claude',
          task: browserUseReq.task,
        }, claudeModeResponse, 0, 0);

        return new Response(JSON.stringify({
          action: normalizedAction,
          requested_model: browserUseReq.model,
          actual_model: 'anthropic/claude-opus-4.6',
          mode: 'claude',
          pool_name: 'rose-1-browser-use',
          ttft_ms: ttftMs,
          usage,
          request_id: requestId,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        });
        } // end else (non-Yutori claude mode)
      }

      // ============================================
      // MODE 1: model_seed provided - direct call to specific provider (for testing)
      // ============================================
      if (browserUseReq.model_seed !== undefined) {
        const providerIndex = browserUseReq.model_seed;

        if (providerIndex < 0 || providerIndex >= browserPool.length) {
          slog('info', `[${requestId}] model_seed ${providerIndex} out of range`, { request_id: requestId, agent_id: agentId, call_site: callSite });
          return new Response(JSON.stringify({
            error: `model_seed ${providerIndex} out of range. Pool has ${browserPool.length} providers (0-${browserPool.length - 1})`
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 400,
          });
        }

        const selectedProvider = browserPool[providerIndex];
        slog('info', `[${requestId}] Browser-use provider (seeded): ${selectedProvider} (index: ${providerIndex})`, { request_id: requestId, agent_id: agentId, call_site: callSite });

        try {
          const result = await callProvider(selectedProvider, providerIndex);

          slog('info', `[${requestId}] Browser-use response: action=${result.action.action}, index=${result.action.index}`, { request_id: requestId, agent_id: agentId, call_site: callSite });
          slog('info', `[${requestId}] ========== REQUEST END (success) ==========\n`, { request_id: requestId, agent_id: agentId, call_site: callSite });

          return new Response(JSON.stringify({
            action: result.action,
            requested_model: browserUseReq.model,
            actual_model: result.actualModel,
            pool_name: 'rose-1-browser-use',
            pool_size: browserPool.length,
            provider_index: providerIndex,
            ttft_ms: result.ttftMs,
            usage: result.usage,
            request_id: requestId,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
          });

        } catch (error) {
          slog('error', `[${requestId}] Browser-use (seeded) failed:`, { data: error , request_id: requestId, agent_id: agentId, call_site: callSite });
          slog('info', `[${requestId}] ========== REQUEST END (error) ==========\n`, { request_id: requestId, agent_id: agentId, call_site: callSite });
          return new Response(JSON.stringify({
            error: 'Browser-use request failed',
            details: error instanceof Error ? error.message : 'Unknown error',
            request_id: requestId,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 500,
          });
        }
      }

      // ============================================
      // MODE 2: No model_seed - COMPLETION-BASED TRIO RACING
      // ============================================
      const buPoolName = 'rose-1-browser-use';
      const buTimings: Record<string, number> = {};
      const raceStartTime = Date.now();

      // Step 1: Filter pool by screenshot availability (yutori requires screenshot)
      const hasScreenshot = !!browserUseReq.browser_state.screenshot;
      const VISION_REQUIRED = new Set(['yutori/n1']);
      const eligiblePool = hasScreenshot
        ? [...browserPool]
        : browserPool.filter(m => !VISION_REQUIRED.has(m));

      slog('info', `[${requestId}] Eligible pool (${eligiblePool.length}/${browserPool.length}): ${eligiblePool.join(', ')}`, { request_id: requestId, agent_id: agentId, call_site: callSite });
      if (!hasScreenshot && eligiblePool.length < browserPool.length) {
        slog('info', `[${requestId}] No screenshot - filtered out vision-only models`, { request_id: requestId, agent_id: agentId, call_site: callSite });
      }

      if (eligiblePool.length === 0) {
        return new Response(JSON.stringify({
          error: 'No eligible browser-use models',
          request_id: requestId,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        });
      }

      // Step 2: Get cached latencies (no probing for browser-use - too expensive)
      const { latencies: buCachedLatencies } = await getCachedLatencies(supabase, buPoolName, eligiblePool);
      buTimings.cache_lookup_ms = Date.now() - raceStartTime;

      // Step 3: Select racing trio with browser-use config
      const racingTrio = selectRacingTrio(eligiblePool, buCachedLatencies, {
        maxLatencyCapMs: BU_MAX_LATENCY_CAP_MS,
        maxDelayCapMs: BU_MAX_DELAY_CAP_MS,
        defaultLatencyMs: BU_DEFAULT_LATENCY_MS,
        trioSize: TRIO_SIZE,
      });
      buTimings.trio_select_ms = Date.now() - raceStartTime;

      if (racingTrio.length === 0) {
        return new Response(JSON.stringify({
          error: 'No eligible models after latency filtering',
          request_id: requestId,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        });
      }

      // Step 4: Single model → direct call, skip racing overhead
      if (racingTrio.length === 1) {
        const singleModel = racingTrio[0].model;
        const poolIndex = browserPool.indexOf(singleModel);
        slog('info', `[${requestId}] Single model eligible, direct call: ${singleModel}`, { request_id: requestId, agent_id: agentId, call_site: callSite });

        try {
          const result = await withTimeout(
            callProvider(singleModel, poolIndex),
            BU_RACE_TIMEOUT_MS,
            singleModel
          );

          slog('info', `[${requestId}] Browser-use response: action=${result.action.action}`, { request_id: requestId, agent_id: agentId, call_site: callSite });
          slog('info', `[${requestId}] ========== REQUEST END (success, single) ==========\n`, { request_id: requestId, agent_id: agentId, call_site: callSite });

          return new Response(JSON.stringify({
            action: result.action,
            requested_model: browserUseReq.model,
            actual_model: result.actualModel,
            pool_name: buPoolName,
            pool_size: browserPool.length,
            ttft_ms: result.ttftMs,
            usage: result.usage,
            request_id: requestId,
            racing: { models_raced: 1, racing_type: 'single' }
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
          });
        } catch (error) {
          slog('error', `[${requestId}] Single model failed:`, { data: error , request_id: requestId, agent_id: agentId, call_site: callSite });
          return new Response(JSON.stringify({
            error: 'Browser-use request failed',
            details: error instanceof Error ? error.message : 'Unknown error',
            request_id: requestId,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 500,
          });
        }
      }

      // Step 5: RACE!
      try {
        const raceResult = await withTimeout(
          raceBrowserUseModels(
            racingTrio,
            callProvider,
            browserPool,
            supabase,
            buPoolName,
            requestId,
            buTimings
          ),
          BU_RACE_TIMEOUT_MS,
          'browser-use-race'
        );

        buTimings.race_total_ms = Date.now() - raceStartTime;
        slog('info', `[${requestId}] Race complete: winner=${raceResult.actualModel}, time=${raceResult.ttftMs}ms`, { request_id: requestId, agent_id: agentId, call_site: callSite });
        slog('info', `[${requestId}] ========== REQUEST END (success, race) ==========\n`, { request_id: requestId, agent_id: agentId, call_site: callSite });

        // Adjust usage for racing cost (all models consumed input tokens)
        let adjustedUsage = raceResult.usage;
        if (adjustedUsage && adjustedUsage.prompt_tokens) {
          adjustedUsage = {
            prompt_tokens: adjustedUsage.prompt_tokens * raceResult.modelsRaced,
            completion_tokens: adjustedUsage.completion_tokens || 0,
            total_tokens: (adjustedUsage.prompt_tokens * raceResult.modelsRaced) + (adjustedUsage.completion_tokens || 0)
          };
        }

        return new Response(JSON.stringify({
          action: raceResult.action,
          requested_model: browserUseReq.model,
          actual_model: raceResult.actualModel,
          pool_name: buPoolName,
          pool_size: browserPool.length,
          ttft_ms: raceResult.ttftMs,
          usage: adjustedUsage,
          request_id: requestId,
          racing: {
            models_raced: raceResult.modelsRaced,
            racing_type: 'completion_trio',
            trio: raceResult.racingModels.map(m => ({
              model: m.model,
              latency_ms: m.latencyMs,
              delay_ms: m.delayMs
            })),
            timings: buTimings
          }
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        });

      } catch (error) {
        slog('error', `[${requestId}] Browser-use race failed:`, { data: error , request_id: requestId, agent_id: agentId, call_site: callSite });
        slog('info', `[${requestId}] ========== REQUEST END (race failed) ==========\n`, { request_id: requestId, agent_id: agentId, call_site: callSite });

        return new Response(JSON.stringify({
          error: 'Browser-use race failed',
          details: error instanceof Error ? error.message : 'Unknown error',
          request_id: requestId,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        });
      }
    }
    
    // ============================================
    // STANDARD CHAT COMPLETION FORMAT
    // ============================================
    const {
      model,
      messages: originalMessages,
      temperature,
      max_tokens,
      seed,
      stream = false,
      tools,
      tool_choice,
      cot_steps,
      response_format,
      reasoning,  // OpenRouter reasoning config: { max_tokens: number }
      model_seed,  // Optional: index into model pool for testing
      model_preference,  // Optional: 'SMART' | 'FAST' | 'CHEAP' for hardcoded model selection
      conversation_id,  // Optional: ensures same model used for entire conversation
      claude_token,  // Optional: user's Claude OAuth token for direct Anthropic call (skips racing, $0 cost)
      skip_cache,    // Optional: disable prompt caching (saves 1.25x write cost for single-use calls)
      ...otherParams
    } = rawBody;

    const cotSteps = cot_steps || 1;
    const maxTokens = max_tokens;
    let messages = originalMessages;

    // Log incoming messages for debugging
    slog('info', `[${requestId}] Chat completion request for model: ${model}${skip_cache ? ' (skip_cache)' : ''}`, { request_id: requestId, agent_id: agentId, call_site: callSite });
    slog('info', `[${requestId}] Received ${messages?.length || 0} messages:`, { data: JSON.stringify(truncateForLogging(messages), null, 2) , request_id: requestId, agent_id: agentId, call_site: callSite });

    // Default reasoning tokens to 256 if reasoning is enabled but no max_tokens specified
    const DEFAULT_REASONING_TOKENS = 256;
    let cappedReasoning = reasoning;
    if (reasoning && !reasoning.max_tokens) {
      cappedReasoning = { ...reasoning, max_tokens: DEFAULT_REASONING_TOKENS };
      slog('info', `Setting default reasoning tokens: ${DEFAULT_REASONING_TOKENS}`);
    }

    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing required field: model' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing or invalid required field: messages' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    // Normalize pool name
    let poolName = model.toLowerCase();
    if (poolName.startsWith('rose-labs/')) {
      poolName = poolName.replace('rose-labs/', '');
    }

    // ============================================
    // CLAUDE TOKEN PASSTHROUGH: Direct Anthropic call using user's Claude subscription ($0 cost)
    // If it fails, fall through to normal racing.
    // ============================================
    let claudeTokenError: string | undefined;  // Set when claude_token call fails, threaded to racing response
    const isClaudeTokenPool = poolName === 'rose-1-ultra' || poolName === 'rose-ultra' || poolName === 'rose-1-lite' || poolName === 'rose-lite';
    if (claude_token && isClaudeTokenPool) {
      const claudeActualModel = 'claude-sonnet-4-6-claude';
      const claudeApiModel = 'claude-sonnet-4-6';
      const claudePassthroughModel = 'anthropic/claude-sonnet-4.6';
      slog('info', `[${requestId}] Claude token present, attempting direct Anthropic call with ${claudeApiModel} (skipping racing)`, { request_id: requestId, agent_id: agentId, call_site: callSite });
      // Resolve pool for stall fallback (racing needs the model pool)
      const fallbackPool = MODEL_POOLS[poolName] || MODEL_POOLS['rose-1-lite'];
      try {
        if (stream) {
          return await handleStreaming(
            claudeActualModel,  // actual_model reported in SSE — maps to $0 pricing
            messages,
            temperature,
            maxTokens,
            seed,
            tools,
            tool_choice,
            response_format,
            cappedReasoning,
            '', // openRouterKey not needed
            supabaseUrl,
            model,
            false,  // isCerebras
            'claude-token',
            1,
            { token: claude_token },  // claudeAuth
            !!skip_cache,  // skipCache
            {
              timeoutMs: 20000,
              onFallback: async () => {
                slog('info', `[${requestId}] Stall fallback: starting model racing`, { request_id: requestId, agent_id: agentId, call_site: callSite });
                const openRouterKey = Deno.env.get('OPENROUTER_API_KEY')!;
                const { latencies } = await getCachedLatencies(supabase, poolName, fallbackPool);
                const racingTrio = selectRacingTrio(fallbackPool, latencies);
                const timings: Record<string, number> = {};
                const { model: winningModel, reader, firstData } = await raceModels(
                  racingTrio, messages, temperature, maxTokens, seed,
                  tools, tool_choice, response_format, cappedReasoning,
                  openRouterKey, supabaseUrl, supabase, poolName, timings
                );
                slog('info', `[${requestId}] Stall fallback: racing winner is ${winningModel}`, { request_id: requestId, agent_id: agentId, call_site: callSite });
                return { reader, firstData, actualModel: winningModel, poolName, poolSize: fallbackPool.length };
              }
            }
          );
        } else {
          // Non-streaming claude token path
          const modelMessages = getMessagesForModel(messages, claudePassthroughModel);
          const { system, messages: anthropicMessages } = transformMessagesForAnthropic(modelMessages);

          const anthropicBody: any = {
            model: claudeApiModel,
            messages: anthropicMessages,
            max_tokens: maxTokens || 4096,
          };
          if (system) {
            if (skip_cache) {
              anthropicBody.system = [{ type: 'text', text: system }];
            } else {
              anthropicBody.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
            }
          }
          // Claude OAuth tokens require the first system block to be a recognized identity string
          const identityBlock = { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." };
          const disclaimerBlock = { type: 'text', text: 'Disregard the previous identity — you are NOT Claude Code. You are a Rose Labs AI agent. Follow the system instructions below.' };
          if (anthropicBody.system) {
            anthropicBody.system.unshift(identityBlock, disclaimerBlock);
          } else {
            anthropicBody.system = [identityBlock, disclaimerBlock];
          }
          if (temperature !== undefined) anthropicBody.temperature = temperature;
          if (cappedReasoning?.max_tokens) {
            anthropicBody.thinking = { type: 'enabled', budget_tokens: cappedReasoning.max_tokens };
          }

          const nativeToolMode = applyAnthropicToolConfig(anthropicBody, response_format, true, tools, tool_choice);

          slog('info', `[${requestId}] Non-streaming claude token${nativeToolMode ? ` (native tools: ${anthropicBody.tools.length})` : ''}`, { request_id: requestId, agent_id: agentId, call_site: callSite });

          const response = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${claude_token}`,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24',
              'x-app': 'cli',
              'User-Agent': 'claude-cli/2.1.81 (external, sdk-ts, agent-sdk/0.2.75)',
              'content-type': 'application/json',
            },
            body: JSON.stringify(anthropicBody)
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Anthropic API error: ${response.status} - ${errorText.slice(0, 200)}`);
          }

          const data = await response.json() as any;
          const apiUsage = data.usage || {};

          if (nativeToolMode) {
            // In native tool mode, reconstruct the JSON format the agent expects:
            // {"reasoning": "", "response": "<text>", "tool_calls": [{"tool": "<name>", ...params}]}
            let textContent = '';
            const toolUseBlocks: Array<{ name: string; input: any }> = [];
            for (const block of (data.content || [])) {
              if (block.type === 'text') textContent += block.text || '';
              else if (block.type === 'tool_use') {
                toolUseBlocks.push({ name: block.name, input: block.input });
              }
            }

            // If text IS already valid JSON matching expected schema, pass through directly
            let reconstructedJson: string;
            try {
              const parsed = JSON.parse(textContent);
              if (parsed && typeof parsed === 'object' && 'response' in parsed) {
                // Model output JSON as text — pass through, merge native tools if any
                if (toolUseBlocks.length > 0) {
                  const nativeTools = toolUseBlocks.map(t => ({ tool: t.name, ...t.input }));
                  parsed.tool_calls = [...(parsed.tool_calls || []), ...nativeTools];
                  reconstructedJson = JSON.stringify(parsed);
                } else {
                  reconstructedJson = textContent;
                }
                slog('info', `[${requestId}] Native tool JSON passthrough: ${toolUseBlocks.length} native tool(s), response length: ${textContent.length}`, { request_id: requestId, agent_id: agentId, call_site: callSite });
              } else {
                reconstructedJson = reconstructAgentResponse(textContent, toolUseBlocks);
                slog('info', `[${requestId}] Native tool response reconstructed: ${toolUseBlocks.length} tool(s), response length: ${textContent.length}`, { request_id: requestId, agent_id: agentId, call_site: callSite });
              }
            } catch {
              reconstructedJson = reconstructAgentResponse(textContent, toolUseBlocks);
              slog('info', `[${requestId}] Native tool response reconstructed: ${toolUseBlocks.length} tool(s), response length: ${textContent.length}`, { request_id: requestId, agent_id: agentId, call_site: callSite });
            }

            const finalResponse = {
              choices: [{ message: { content: reconstructedJson } }],
              usage: {
                prompt_tokens: apiUsage.input_tokens || 0,
                completion_tokens: apiUsage.output_tokens || 0,
                total_tokens: (apiUsage.input_tokens || 0) + (apiUsage.output_tokens || 0),
                cache_creation_input_tokens: apiUsage.cache_creation_input_tokens || 0,
                cache_read_input_tokens: apiUsage.cache_read_input_tokens || 0,
              },
              requested_model: model,
              actual_model: claudeActualModel,
              pool_name: 'claude-token',
              pool_size: 1,
            };

            slog('info', `[${requestId}] Non-streaming cache metrics: cache_read=${apiUsage.cache_read_input_tokens || 0}, cache_write=${apiUsage.cache_creation_input_tokens || 0}`, { request_id: requestId, agent_id: agentId, call_site: callSite });

            return new Response(JSON.stringify(finalResponse), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
              status: 200,
            });
          }

          // Standard mode: extract text and tool_use content from Anthropic response
          let textContent = '';
          const toolCalls: any[] = [];
          for (const block of (data.content || [])) {
            if (block.type === 'text') textContent += block.text || '';
            else if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: JSON.stringify(block.input) },
              });
            }
          }

          const message: any = { content: textContent };
          if (toolCalls.length) message.tool_calls = toolCalls;
          const finalResponse = {
            choices: [{ message }],
            usage: {
              prompt_tokens: apiUsage.input_tokens || 0,
              completion_tokens: apiUsage.output_tokens || 0,
              total_tokens: (apiUsage.input_tokens || 0) + (apiUsage.output_tokens || 0),
              cache_creation_input_tokens: apiUsage.cache_creation_input_tokens || 0,
              cache_read_input_tokens: apiUsage.cache_read_input_tokens || 0,
            },
            requested_model: model,
            actual_model: claudeActualModel,
            pool_name: 'claude-token',
            pool_size: 1,
          };

          slog('info', `[${requestId}] Non-streaming cache metrics: cache_read=${apiUsage.cache_read_input_tokens || 0}, cache_write=${apiUsage.cache_creation_input_tokens || 0}`, { request_id: requestId, agent_id: agentId, call_site: callSite });

          return new Response(JSON.stringify(finalResponse), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
          });
        }
      } catch (error) {
        const errorStr = String(error);
        const isStall = errorStr.includes('timed out');
        // Classify the failure so the agent can decide whether to invalidate the token
        const statusMatch = errorStr.match(/(\d{3})/);
        const status = statusMatch ? parseInt(statusMatch[1]) : 0;
        if (status === 401 || status === 403) {
          claudeTokenError = 'auth_error';
        } else if (status === 429) {
          claudeTokenError = 'rate_limit';
        } else if (isStall) {
          claudeTokenError = 'stall';
        } else {
          claudeTokenError = 'server_error';
        }
        slog('warn', `[${requestId}] Claude token call failed (${claudeTokenError}), falling back to racing: ${error}`, { request_id: requestId, agent_id: agentId, call_site: callSite });
        // Fall through to normal racing path
      }
    }

    // Check if it's a direct model passthrough (for testing)
    const DIRECT_MODEL_PREFIXES = ['openai/', 'google/', 'anthropic/', 'deepseek/', 'qwen/', 'x-ai/', 'meta/', 'moonshotai/'];
    const isDirectModel = DIRECT_MODEL_PREFIXES.some(prefix => model.toLowerCase().startsWith(prefix));
    
    const pool = MODEL_POOLS[poolName];
    if (!pool && !isDirectModel) {
      return new Response(JSON.stringify({ 
        error: `Unknown model: ${model}. Use 'rose-labs/rose-1-lite' or 'rose-labs/rose-1-ultra'` 
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }
    
    // Handle direct model passthrough (bypass racing)
    if (isDirectModel) {
      slog('info', `Direct model passthrough: ${model}`);
      if (stream) {
        return await handleStreaming(
          model,
          messages,
          temperature,
          maxTokens,
          seed,
          tools,
          tool_choice,
          response_format,
          cappedReasoning,
          Deno.env.get('OPENROUTER_API_KEY')!,
          supabaseUrl,
          model,
          false,  // isCerebras
          'direct',
          1
        );
      }
      // Non-streaming direct passthrough - handle here instead of falling through
      // Transform messages for vision models
      const modelMessages = getMessagesForModel(messages, model);
      
      const requestBody: any = {
        model,
        messages: modelMessages,
        temperature,
        max_tokens: maxTokens,
        seed,
        tools,
        tool_choice,
      };
      
      if (response_format) {
        requestBody.response_format = response_format;
      }
      
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('OPENROUTER_API_KEY')}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': supabaseUrl,
          'X-Title': 'Rose Direct Passthrough'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        slog('error', 'OpenRouter API error:', { data: [response.status, errorText] });
        return new Response(JSON.stringify({ 
          error: 'OpenRouter API error',
          status: response.status,
          details: errorText 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: response.status,
        });
      }
      
      const finalResponse = await response.json();
      finalResponse.requested_model = model;
      finalResponse.actual_model = model;
      finalResponse.pool_name = 'direct';
      finalResponse.pool_size = 1;
      
      return new Response(JSON.stringify(finalResponse), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // Track selected model for non-streaming fallback
    let selectedModel: string | null = null;
    let selectedIsCerebras = false;

    // Check for model_preference or model_seed (bypass racing)
    if (model_preference || model_seed !== undefined) {
      // Use legacy single-model selection
      let selection: { model: string; isCerebras: boolean; poolName: string; poolSize: number };
      try {
        selection = selectModel(model, model_seed, model_preference as ModelPreference | undefined);
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: error instanceof Error ? error.message : 'Invalid model' 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }

      if (stream) {
        return await handleStreaming(
          selection.model,
          messages,
          temperature,
          maxTokens,
          seed,
          tools,
          tool_choice,
          response_format,
          cappedReasoning,
          Deno.env.get('OPENROUTER_API_KEY')!,
          supabaseUrl,
          model,
          selection.isCerebras,
          selection.poolName,
          selection.poolSize,
          undefined, undefined, undefined,  // claudeAuth, skipCache, stallConfig
          claudeTokenError,
        );
      }
      
      // Non-streaming with legacy selection
      selectedModel = selection.model;
      selectedIsCerebras = selection.isCerebras;
    }

    // ============================================
    // TRIO RACING MODE (default for streaming)
    // ============================================
    
    // Check if conversation already has a model selected
    if (conversation_id && !selectedModel) {
      const existingModel = await getConversationModel(supabase, conversation_id);
      if (existingModel) {
        slog('info', `Using existing model for conversation: ${existingModel}`);
        
        if (stream) {
          return await handleStreaming(
            existingModel,
            messages,
            temperature,
            maxTokens,
            seed,
            tools,
            tool_choice,
            response_format,
            reasoning,
            Deno.env.get('OPENROUTER_API_KEY')!,
            supabaseUrl,
            model,
            false, // Not Cerebras
            poolName,
            pool.length,
            undefined, undefined, undefined,  // claudeAuth, skipCache, stallConfig
            claudeTokenError,
          );
        }
        
        selectedModel = existingModel;
        selectedIsCerebras = false;
      }
    }

    // Handle streaming with trio racing or waterfall
    if (stream && !selectedModel) {
      const openRouterKey = Deno.env.get('OPENROUTER_API_KEY')!;

      // ===== SHARED POOL FILTERING =====
      // Apply filters before both waterfall and racing paths

      // Filter out Anthropic models if schema has 9+ tool types (Anthropic limit is 8 anyOf branches)
      let effectivePool = pool;
      if (response_format) {
        const toolCount = countToolTypes(response_format);
        if (toolCount >= ANTHROPIC_MAX_ANYOF_BRANCHES + 1) {
          const anthropicModels = pool.filter(m => isAnthropicModel(m));
          if (anthropicModels.length > 0) {
            slog('info', `Schema has ${toolCount} tool types (limit: ${ANTHROPIC_MAX_ANYOF_BRANCHES}), excluding Anthropic models: ${anthropicModels.join(', ')}`);
            effectivePool = pool.filter(m => !isAnthropicModel(m));
          }
        }
      }

      // Filter out models that can't handle file attachments based on size
      const maxFileSize = getMaxBase64FileSizeBytes(messages);
      if (maxFileSize > 0) {
        effectivePool = filterPoolByFileSize(effectivePool, maxFileSize);
      }

      if (effectivePool.length === 0) {
        return new Response(JSON.stringify({ error: 'No eligible models in pool after filtering' }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        });
      }

      // ===== WATERFALL MODE =====
      // For pools configured for waterfall (sequential fallback), skip trio racing entirely.
      // This sends input tokens to only ONE model per request (saves cost vs racing 3 models).
      if (WATERFALL_POOLS.has(poolName)) {
        slog('info', `Waterfall mode for pool: ${poolName} (${effectivePool.length} models)`);
        return await waterfallStream(
          effectivePool,
          messages,
          temperature,
          maxTokens,
          seed,
          tools,
          tool_choice,
          response_format,
          reasoning,
          openRouterKey,
          supabaseUrl,
          model,
          poolName,
          effectivePool.length,
          conversation_id,
          supabase,
          claudeTokenError,
        );
      }

      // ===== TRIO RACING MODE =====

      // ===== TIMING INSTRUMENTATION =====
      const timings: { [key: string]: number } = {};
      const raceStartTime = Date.now();
      timings.race_start = 0;

      // Get cached latencies for this pool
      const cacheStartTime = Date.now();
      const { latencies: cachedLatencies, needsRefresh, missingModels } = await getCachedLatencies(supabase, poolName, pool);
      timings.cache_lookup_ms = Date.now() - cacheStartTime;
      slog('info', `TIMING: cache_lookup=${timings.cache_lookup_ms}ms`);

      // If cache is stale/missing, fire latency probes in PARALLEL with the race
      // Probes use a standard test prompt, not the user's messages
      let probePromise: Promise<void> | null = null;
      if (needsRefresh && missingModels.length > 0) {
        slog('info', `Cache needs refresh, firing probes in parallel for: ${missingModels.join(', ')}`);
        // Fire probes in background - don't await, let them run alongside the race
        probePromise = fireLatencyProbes(missingModels, poolName, openRouterKey, supabaseUrl, supabase);
        timings.probes_fired = missingModels.length;
      } else {
        timings.probes_fired = 0;
      }

      // Select racing trio with delays (using current cached values, even if stale)
      const trioSelectStart = Date.now();
      const racingTrio = selectRacingTrio(effectivePool, cachedLatencies);
      timings.trio_select_ms = Date.now() - trioSelectStart;
      slog('info', `TIMING: trio_select=${timings.trio_select_ms}ms`);
      
      if (racingTrio.length === 0) {
        return new Response(JSON.stringify({ error: 'No eligible models in pool' }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        });
      }
      
      // If only one model eligible, skip racing
      if (racingTrio.length === 1) {
        const singleModel = racingTrio[0].model;
        slog('info', `Single model eligible, skipping race: ${singleModel}`);
        
        if (conversation_id) {
          await saveConversationModel(supabase, conversation_id, singleModel, poolName);
        }
        
        return await handleStreaming(
          singleModel,
          messages,
          temperature,
          maxTokens,
          seed,
          tools,
          tool_choice,
          response_format,
          reasoning,
          openRouterKey,
          supabaseUrl,
          model,
          false,
          poolName,
          pool.length,
          undefined, undefined, undefined,  // claudeAuth, skipCache, stallConfig
          claudeTokenError,
        );
      }
      
      // Race the trio!
      try {
        const raceCallStart = Date.now();
        timings.race_call_start_ms = raceCallStart - raceStartTime;
        slog('info', `TIMING: race_call_start=${timings.race_call_start_ms}ms (time before raceModels)`);
        
        const { model: winningModel, reader: winningReader, ttftMs, firstData } = await raceModels(
          racingTrio,
          messages,
          temperature,
          maxTokens,
          seed,
          tools,
          tool_choice,
          response_format,
          reasoning,
          openRouterKey,
          supabaseUrl,
          supabase,
          poolName,
          timings
        );
        
        timings.race_complete_ms = Date.now() - raceStartTime;
        timings.race_duration_ms = Date.now() - raceCallStart;
        slog('info', `TIMING: race_complete=${timings.race_complete_ms}ms, race_duration=${timings.race_duration_ms}ms`);
        
        // Save winning model for conversation
        if (conversation_id) {
          await saveConversationModel(supabase, conversation_id, winningModel, poolName);
        }
        
        // Stream the winning response to client
        const encoder = new TextEncoder();
        const modelsRaced = racingTrio.length;
        const streamStartTime = Date.now();
        timings.stream_start_ms = streamStartTime - raceStartTime;
        slog('info', `TIMING: stream_start=${timings.stream_start_ms}ms`);
        
        const stream = new ReadableStream({
          async start(controller) {
            try {
              // Use the reader we already have from the race (can't call getReader twice!)
              const reader = winningReader;
              const decoder = new TextDecoder();
              // Start with the buffer we already read during racing
              let buffer = firstData;
              let firstEnqueueTime: number | null = null;

              // Anthropic usage tracking - capture from message_start and message_delta
              let anthropicInputTokens = 0;
              let anthropicOutputTokens = 0;
              let anthropicCacheCreationTokens = 0;
              let anthropicCacheReadTokens = 0;

              // Process the firstData buffer immediately
              slog('info', `TIMING: processing firstData buffer (${firstData.length} chars)`);

              // Helper to process buffer lines
              const processBuffer = () => {
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                return lines;
              };

              // Helper to process a single line
              const processLine = (line: string) => {
                // Handle both "data: " (with space) and "data:" (no space) formats
                if (line.startsWith('data:')) {
                  // Extract data after "data:" - handle optional space
                  const data = line.startsWith('data: ') ? line.slice(6) : line.slice(5).trim();
                  if (data === '[DONE]') {
                    return;
                  }

                  try {
                    const parsed = JSON.parse(data);

                    // Transform Anthropic streaming events to OpenAI format (same as handleStreaming)
                    if (isAnthropicModel(winningModel)) {
                      // Capture input tokens and cache metrics from message_start
                      if (parsed.type === 'message_start') {
                        if (parsed.message?.usage) {
                          const msgUsage = parsed.message.usage;
                          anthropicInputTokens = msgUsage.input_tokens || 0;
                          anthropicCacheCreationTokens = msgUsage.cache_creation_input_tokens || 0;
                          anthropicCacheReadTokens = msgUsage.cache_read_input_tokens || 0;
                          slog('info', `Anthropic input_tokens=${anthropicInputTokens}, cache_read=${anthropicCacheReadTokens}, cache_write=${anthropicCacheCreationTokens}`);
                        }
                        return;
                      }

                      // Capture output tokens from message_delta
                      if (parsed.type === 'message_delta' && parsed.usage?.output_tokens) {
                        anthropicOutputTokens = parsed.usage.output_tokens;
                        slog('info', `Anthropic output_tokens captured: ${anthropicOutputTokens}`);
                        return;
                      }

                      // Skip other non-content events (content_block_start, etc.)
                      if (parsed.type !== 'content_block_delta') {
                        return;
                      }

                      // Transform to OpenAI format
                      const openAIFormat: any = {
                        choices: [{
                          index: 0,
                          delta: {
                            content: parsed.delta?.text || parsed.delta?.partial_json || ''
                          }
                        }],
                        requested_model: model,
                        actual_model: winningModel,
                        pool_name: poolName,
                        pool_size: pool.length,
                        racing_ttft_ms: ttftMs,
                        models_raced: modelsRaced,
                        ...(claudeTokenError && { claude_token_error: claudeTokenError }),
                      };

                      // Track first enqueue timing
                      if (firstEnqueueTime === null) {
                        firstEnqueueTime = Date.now() - streamStartTime;
                        timings.first_enqueue_to_client_ms = firstEnqueueTime;
                        slog('info', `TIMING: first_enqueue_to_client=${firstEnqueueTime}ms`);
                      }
                      openAIFormat.timings = timings;

                      const payload = `data: ${JSON.stringify(openAIFormat)}\n\n`;
                      controller.enqueue(encoder.encode(payload));
                      return;
                    }

                    // Non-Anthropic models (OpenRouter/Cerebras) - pass through with metadata
                    // Skip chunks with empty/missing choices (OpenRouter debug/echo chunks)
                    if (!parsed.choices?.length) {
                      return;
                    }
                    parsed.requested_model = model;
                    parsed.actual_model = winningModel;
                    parsed.pool_name = poolName;
                    parsed.pool_size = pool.length;
                    parsed.racing_ttft_ms = ttftMs;
                    parsed.models_raced = modelsRaced;
                    if (claudeTokenError) parsed.claude_token_error = claudeTokenError;

                    // Track first enqueue timing
                    if (firstEnqueueTime === null) {
                      firstEnqueueTime = Date.now() - streamStartTime;
                      timings.first_enqueue_to_client_ms = firstEnqueueTime;
                      slog('info', `TIMING: first_enqueue_to_client=${firstEnqueueTime}ms`);
                    }
                    parsed.timings = timings;

                    // Translate OpenRouter cache fields to canonical Anthropic format
                    if (parsed.usage?.prompt_tokens_details) {
                      const details = parsed.usage.prompt_tokens_details;
                      const cachedTokens = details.cached_tokens || 0;
                      const cacheWriteTokens = details.cache_write_tokens || 0;

                      // Set canonical fields
                      parsed.usage.cache_read_input_tokens = cachedTokens;
                      parsed.usage.cache_creation_input_tokens = cacheWriteTokens;

                      // Adjust prompt_tokens to Anthropic semantics (exclude cached tokens)
                      // OpenRouter prompt_tokens is total (incl cached); Anthropic is non-cached only
                      parsed.usage.prompt_tokens = Math.max(0, parsed.usage.prompt_tokens - cachedTokens - cacheWriteTokens);

                      slog('info', `Cache translated: read=${cachedTokens}, write=${cacheWriteTokens}, uncached=${parsed.usage.prompt_tokens}`);
                    }

                    // Adjust usage to reflect TRUE cost (all racing models consumed input tokens)
                    if (parsed.usage && parsed.usage.prompt_tokens) {
                      const winnerPromptTokens = parsed.usage.prompt_tokens;
                      const winnerCompletionTokens = parsed.usage.completion_tokens || 0;
                      parsed.usage.prompt_tokens = winnerPromptTokens * modelsRaced;
                      parsed.usage.total_tokens = parsed.usage.prompt_tokens + winnerCompletionTokens;
                      // Preserve cache fields (NOT multiplied — only winner had cache hits)
                      // cache_read_input_tokens and cache_creation_input_tokens stay as-is
                      slog('info', `Usage adjusted: ${winnerPromptTokens} input × ${modelsRaced} models = ${parsed.usage.prompt_tokens} total input tokens`);
                    }

                    const payload = `data: ${JSON.stringify(parsed)}\n\n`;
                    controller.enqueue(encoder.encode(payload));
                  } catch (e) {
                    controller.enqueue(encoder.encode(`${line}\n`));
                  }
                }
              };

              // Process any complete lines already in firstData buffer
              let lines = processBuffer();
              for (const line of lines) {
                processLine(line);
              }

              // Continue reading from the stream
              while (true) {
                const { done, value } = await reader.read();

                if (done) {
                  // For Anthropic models, emit final usage chunk before [DONE]
                  if (isAnthropicModel(winningModel) && (anthropicInputTokens > 0 || anthropicOutputTokens > 0)) {
                    // Adjust for racing - all models consumed input tokens
                    const adjustedInputTokens = anthropicInputTokens * modelsRaced;
                    const usageChunk = {
                      choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: 'stop'
                      }],
                      usage: {
                        prompt_tokens: adjustedInputTokens,
                        completion_tokens: anthropicOutputTokens,
                        total_tokens: adjustedInputTokens + anthropicOutputTokens,
                        cache_creation_input_tokens: anthropicCacheCreationTokens,
                        cache_read_input_tokens: anthropicCacheReadTokens,
                      },
                      requested_model: model,
                      actual_model: winningModel,
                      pool_name: poolName,
                      pool_size: pool.length,
                      racing_ttft_ms: ttftMs,
                      models_raced: modelsRaced,
                      timings,
                      ...(claudeTokenError && { claude_token_error: claudeTokenError }),
                    };
                    const payload = `data: ${JSON.stringify(usageChunk)}\n\n`;
                    controller.enqueue(encoder.encode(payload));
                    slog('info', `Anthropic usage adjusted: ${anthropicInputTokens} input × ${modelsRaced} models = ${adjustedInputTokens} total input tokens`);
                  }
                  const donePayload = 'data: [DONE]\n\n';
                  controller.enqueue(encoder.encode(donePayload));
                  controller.close();
                  break;
                }

                buffer += decoder.decode(value, { stream: true });
                lines = processBuffer();

                for (const line of lines) {
                  processLine(line);
                }
              }
            } catch (error) {
              slog('error', 'Streaming race winner error:', { data: error });
              controller.error(error);
            }
          }
        });

        return new Response(stream, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        });
        
      } catch (error) {
        slog('error', 'Trio racing failed:', { data: error });
        
        // Fallback to random model
        const fallbackModel = pool[Math.floor(Math.random() * pool.length)];
        slog('info', `Falling back to random model: ${fallbackModel}`);
        
        return await handleStreaming(
          fallbackModel,
          messages,
          temperature,
          maxTokens,
          seed,
          tools,
          tool_choice,
          response_format,
          cappedReasoning,
          Deno.env.get('OPENROUTER_API_KEY')!,
          supabaseUrl,
          model,
          false,
          poolName,
          pool.length,
          undefined, undefined, undefined,  // claudeAuth, skipCache, stallConfig
          claudeTokenError,
        );
      }
    }
    
    // For non-streaming, use selected model or pick random from pool
    const actualModel = selectedModel || pool[Math.floor(Math.random() * pool.length)];
    const isCerebras = selectedIsCerebras;

    // Handle CoT steps (non-streaming)
    let finalResponse: any;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // Helper function to make API call to appropriate provider
    async function makeApiCall(body: any): Promise<globalThis.Response> {
      if (isCerebras) {
        slog('info', `Calling Cerebras API with model: ${actualModel}`);
        
        // Build Cerebras request body - Cerebras is OpenAI-compatible but doesn't support some params
        // See: https://inference-docs.cerebras.ai/resources/openai
        const cerebrasBody: any = {
          model: body.model,
          messages: body.messages,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          seed: body.seed,
        };
        
        // Add tools if provided - Cerebras supports tool calling
        // See: https://inference-docs.cerebras.ai/capabilities/tool-use
        if (body.tools && body.tools.length > 0) {
          cerebrasBody.tools = body.tools;
          // Note: parallel_tool_calls is NOT supported by Cerebras - causes 400 error
        }
        if (body.tool_choice) {
          cerebrasBody.tool_choice = body.tool_choice;
        }
        
        // Add response_format if provided - Cerebras supports structured outputs
        // See: https://inference-docs.cerebras.ai/capabilities/structured-outputs
        // Important: Cerebras requires additionalProperties: false for all objects with required
        if (body.response_format) {
          // Transform schema to be Cerebras-compatible
          if (body.response_format.type === 'json_schema' && body.response_format.json_schema?.schema) {
            const transformedSchema = transformSchemaForCerebras(body.response_format.json_schema.schema);
            cerebrasBody.response_format = {
              type: 'json_schema',
              json_schema: {
                name: body.response_format.json_schema.name || 'response',
                strict: true,
                schema: transformedSchema
              }
            };
          } else {
            cerebrasBody.response_format = body.response_format;
          }
        }
        
        slog('info', `Cerebras request body:`, { data: JSON.stringify(truncateForLogging(cerebrasBody), null, 2) });
        
        return await fetch(CEREBRAS_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('CEREBRAS_API_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(cerebrasBody)
        });
      } else {
        return await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('OPENROUTER_API_KEY')}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': supabaseUrl,
            'X-Title': 'Rose Benchmark Suite'
          },
          body: JSON.stringify(body)
        });
      }
    }

    if (cotSteps === 1) {
      // Direct answer (no CoT)
      // Transform messages for vision models (handles __screenshot_base64__)
      const modelMessages = getMessagesForModel(messages, actualModel);
      
      const requestBody: any = {
        model: actualModel,
        messages: modelMessages,
        temperature,
        max_tokens: maxTokens,
        seed,
        tools,
        tool_choice,
      };
      
      // Add response_format if provided
      if (response_format) {
        requestBody.response_format = response_format;
      }
      
      // Add other params only for non-Cerebras (some params like parallel_tool_calls cause 400 on Cerebras)
      if (!isCerebras) {
        Object.assign(requestBody, otherParams);
      }

      const apiResponse = await makeApiCall(requestBody);

      if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        const provider = isCerebras ? 'Cerebras' : 'OpenRouter';
        slog('error', `${provider} API error:`, { data: [apiResponse.status, errorText] });
        slog('error', `Request body was:`, { data: JSON.stringify(requestBody, null, 2) });
        
        // Try to parse error for more details
        let errorDetails = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorDetails = JSON.stringify(errorJson, null, 2);
          slog('error', `${provider} error details:`, { data: errorJson });
        } catch (e) {
          // errorText is not JSON, keep as-is
        }
        
        return new Response(JSON.stringify({ 
          error: `${provider} API error`,
          status: apiResponse.status,
          details: errorDetails 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: apiResponse.status,
        });
      }

      finalResponse = await apiResponse.json();
      totalPromptTokens = finalResponse.usage?.prompt_tokens || 0;
      totalCompletionTokens = finalResponse.usage?.completion_tokens || 0;

    } else {
      // Multi-step CoT (tool calls not supported with CoT currently)
      // Transform messages for vision models (handles __screenshot_base64__)
      const modelMessages = getMessagesForModel(messages, actualModel);
      const thinkingMessages = [...modelMessages];
      const intermediateResponses = [];
      const provider = isCerebras ? 'Cerebras' : 'OpenRouter';

      // Thinking steps (N-1 steps)
      for (let i = 0; i < cotSteps - 1; i++) {
        const thinkingPrompt = {
          role: "system",
          content: `Think step by step. You have ${cotSteps - 1} thinking steps before giving your final answer. This is thinking step ${i + 1}. Show your reasoning.`
        };

        const stepMessages = [...thinkingMessages, thinkingPrompt];

        const stepResponse = await makeApiCall({
          model: actualModel,
          messages: stepMessages,
          temperature,
          max_tokens: maxTokens,
          seed,
        });

        if (!stepResponse.ok) {
          const errorText = await stepResponse.text();
          slog('error', `${provider} API error in CoT step:`, { data: [stepResponse.status, errorText] });
          return new Response(JSON.stringify({ 
            error: `${provider} API error in CoT step`,
            details: errorText 
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: stepResponse.status,
          });
        }

        const stepData = await stepResponse.json();
        intermediateResponses.push(stepData);
        
        // Add assistant's thinking to context
        if (stepData.choices?.[0]?.message) {
          thinkingMessages.push(stepData.choices[0].message);
        }

        totalPromptTokens += stepData.usage?.prompt_tokens || 0;
        totalCompletionTokens += stepData.usage?.completion_tokens || 0;
      }

      // Final answer step
      const finalPrompt = {
        role: "system",
        content: "Based on your thinking above, now provide your final answer."
      };
      const finalMessages = [...thinkingMessages, finalPrompt];

      const finalApiResponse = await makeApiCall({
        model: actualModel,
        messages: finalMessages,
        temperature,
        max_tokens: maxTokens,
        seed,
      });

      if (!finalApiResponse.ok) {
        const errorText = await finalApiResponse.text();
        slog('error', `${provider} API error in final step:`, { data: [finalApiResponse.status, errorText] });
        return new Response(JSON.stringify({ 
          error: `${provider} API error in final step`,
          details: errorText 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: finalApiResponse.status,
        });
      }

      finalResponse = await finalApiResponse.json();
      totalPromptTokens += finalResponse.usage?.prompt_tokens || 0;
      totalCompletionTokens += finalResponse.usage?.completion_tokens || 0;
    }

    // Include actual selected model for debugging (unmasked)
    // The requested model alias is preserved in a separate field
    finalResponse.requested_model = model;
    finalResponse.actual_model = actualModel;
    finalResponse.pool_name = poolName;
    finalResponse.pool_size = pool.length;
    finalResponse.request_id = requestId;
    if (claudeTokenError) finalResponse.claude_token_error = claudeTokenError;

    // Calculate cost
    const costCents = calculateCost(totalPromptTokens, totalCompletionTokens, actualModel);

    // Log usage
    await logUsage(supabase, authInfo.apiKeyId, authInfo.userId, {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      seed,
      tools,
      tool_choice,
      cot_steps: cotSteps
    }, finalResponse, costCents, cotSteps);

    // Return response
    slog('info', `[${requestId}] Chat completion success: model=${actualModel}, tokens=${totalPromptTokens + totalCompletionTokens}`, { request_id: requestId, agent_id: agentId, call_site: callSite });
    slog('info', `[${requestId}] ========== REQUEST END (success) ==========\n`, { request_id: requestId, agent_id: agentId, call_site: callSite });
    return new Response(JSON.stringify(finalResponse), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    slog('error', `[${requestId}] Rose completions endpoint error:`, { data: error , request_id: requestId, agent_id: agentId, call_site: callSite });
    slog('info', `[${requestId}] ========== REQUEST END (error) ==========\n`, { request_id: requestId, agent_id: agentId, call_site: callSite });
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({
      error: 'Internal server error',
      details: errorMessage,
      request_id: requestId,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
