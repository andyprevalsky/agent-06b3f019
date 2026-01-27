import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};

// ============================================
// LATENCY RACING CONFIGURATION
// ============================================
const MAX_LATENCY_CAP_MS = 3000;    // Models with TTFT > 3s excluded entirely
const MAX_DELAY_CAP_MS = 1000;      // Max delay to equalize latencies (faster models excluded if need more delay)
const LATENCY_CACHE_TTL_MS = 60000; // 1 minute cache TTL
const TRIO_SIZE = 3;                // Race 3 models per request

// Model pools for Rose variants - sync with backend/src/routes/rose.ts
const MODEL_POOLS: Record<string, string[]> = {
  'rose-1-lite': [
    'moonshotai/kimi-k2-0905',
    'openai/gpt-5.2',
    'google/gemini-2.5-flash',
    'anthropic/claude-haiku-4.5'
  ],
  'rose-1-ultra': [
    'anthropic/claude-opus-4-5-20251101',
    'openai/gpt-5.2',
    'google/gemini-3-pro-preview',
    'moonshotai/kimi-k2.5'
  ],
  // Browser automation pool - specialized models for web interaction
  'rose-1-browser-use': [
    'browser-use',              // Index 0 - Their hosted LLM (bu-1-0)
    'yutori/n1',                // Index 1 - Vision-only, coordinate output
  ]
};

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
    console.log(`📁 File size ${(maxFileSizeBytes / 1024 / 1024).toFixed(2)}MB, excluded models: ${excluded.join(', ')}`);
  }

  return filtered;
}

// Browser-use API configuration
const BROWSER_USE_API_URL = 'https://llm.api.browser-use.com/v1/chat/completions';

// Yutori n1 API configuration
const YUTORI_API_URL = 'https://api.yutori.com/v1/chat/completions';
const YUTORI_MODEL = 'n1-preview-2025-11';

// Anthropic CUA (Computer Use) API configuration
const ANTHROPIC_CUA_MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_CUA_BETA = 'computer-use-2025-01-24';

// Browser-use pool configuration
const BROWSER_USE_TIMEOUT_MS = 10000;  // 10 second timeout per provider

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
const DOM_ONLY_MODELS = ['openai/gpt-5.2'];

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
  apiKey: string
): Promise<{ response: any; ttftMs: number; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const { messages } = transformToBrowserUseFormat(req);
  
  console.log('📤 browser-use request messages:', JSON.stringify(messages, null, 2));
  
  const startTime = Date.now();
  
  // Don't pass output_format - let browser-use API use its internal format
  const requestBody = {
    model: 'bu-1-0',
    messages,
    request_type: 'browser_agent',
    fast: false,
  };
  
  console.log('📤 browser-use full request:', JSON.stringify(truncateForLogging(requestBody), null, 2));
  
  const response = await fetch(BROWSER_USE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody)
  });
  
  const ttftMs = Date.now() - startTime;
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('browser-use API error:', response.status, errorText);
    throw new Error(`browser-use API error: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  console.log('📥 browser-use raw response:', JSON.stringify(data, null, 2));
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

// Transform unified request to Yutori format
// Yutori expects: user message, then alternating observation (screenshot) and assistant messages
// Screenshot can be a URL or base64 data URI
function transformToYutoriFormat(req: BrowserUseRequest): {
  messages: any[];
} {
  const messages: any[] = [];
  
  // Initial user message with task
  // Per Yutori docs: "place any additional necessary instructions in the first user message, after the main task description"
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: `Task: ${req.task}` }
    ]
  });
  
  // Add action history as observation/assistant pairs
  // Track last known URL for observation messages
  let lastKnownUrl = req.browser_state.url;
  
  for (const entry of req.action_history) {
    // Update URL tracking if this was a navigation action
    if (entry.action === 'goto' && entry.params?.url) {
      lastKnownUrl = entry.params.url;
    }
    
    // Screenshot from history as observation
    // Per Yutori docs: "Including the URL of the current page in observation messages is recommended"
    if (entry.screenshot) {
      // Check if it's already a URL or if it's base64
      const imageUrl = entry.screenshot.startsWith('http') 
        ? entry.screenshot 
        : `data:image/png;base64,${entry.screenshot}`;
      
      const observationContent: any[] = [];
      
      // Add URL as text before the screenshot (recommended by Yutori docs)
      if (lastKnownUrl) {
        observationContent.push({ type: 'text', text: `Current URL: ${lastKnownUrl}` });
      }
      
      observationContent.push({ type: 'image_url', image_url: { url: imageUrl } });
      
      messages.push({
        role: 'observation',
        content: observationContent
      });
    }
    
    // Previous action as assistant response
    // Convert coordinates to 1000x1000 normalized space for Yutori
    let normalizedCoords: [number, number] | undefined;
    if (entry.coordinates) {
      normalizedCoords = [
        Math.round((entry.coordinates.x / req.browser_state.viewport.width) * 1000),
        Math.round((entry.coordinates.y / req.browser_state.viewport.height) * 1000)
      ];
      // Tracing: log coordinate transform
      console.log('📸 [YUTORI] Coordinate transform', {
        original: `${entry.coordinates.x},${entry.coordinates.y}`,
        normalized: `${normalizedCoords[0]},${normalizedCoords[1]}`,
        viewport: `${req.browser_state.viewport.width}x${req.browser_state.viewport.height}`
      });
    }
    
    const actionResponse = {
      thoughts: entry.thinking || `Executed ${entry.action}`,
      actions: [{
        action_type: entry.action,
        ...(normalizedCoords ? { center_coordinates: normalizedCoords } : {}),
        ...(entry.params || {})
      }]
    };
    
    messages.push({
      role: 'assistant',
      content: JSON.stringify(actionResponse)
    });
  }
  
  // Current screenshot as final observation
  // Per Yutori docs: "Including the URL of the current page in observation messages is recommended"
  if (req.browser_state.screenshot) {
    // Check if it's already a URL or if it's base64
    const imageUrl = req.browser_state.screenshot.startsWith('http') 
      ? req.browser_state.screenshot 
      : `data:image/png;base64,${req.browser_state.screenshot}`;
    
    const observationContent: any[] = [];
    
    // Add current URL as text before the screenshot
    if (req.browser_state.url) {
      observationContent.push({ type: 'text', text: `Current URL: ${req.browser_state.url}` });
    }
    
    observationContent.push({ type: 'image_url', image_url: { url: imageUrl } });
    
    messages.push({
      role: 'observation',
      content: observationContent
    });
  }

  // Tracing: log Yutori messages summary
  console.log('🔍 [TRACE] Yutori messages:', {
    total: messages.length,
    assistantCount: messages.filter(m => m.role === 'assistant').length,
    observationCount: messages.filter(m => m.role === 'observation').length
  });

  return { messages };
}

// Call Yutori n1 API
async function callYutoriLLM(
  req: BrowserUseRequest,
  apiKey: string
): Promise<{ response: any; ttftMs: number; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const { messages } = transformToYutoriFormat(req);
  
  console.log('📤 Yutori request messages count:', messages.length);
  console.log('📤 Yutori request messages:', JSON.stringify(messages, null, 2));
  
  const requestBody = {
    model: YUTORI_MODEL,
    messages,
    temperature: 0.3
  };
  
  console.log('📤 Yutori full request body:', JSON.stringify(truncateForLogging(requestBody), null, 2));
  
  const startTime = Date.now();
  
  const response = await fetch(YUTORI_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody)
  });
  
  const ttftMs = Date.now() - startTime;
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('Yutori API error:', response.status, errorText);
    throw new Error(`Yutori API error: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  console.log('📥 Yutori raw response:', JSON.stringify(data, null, 2));
  // Extract usage if available (Yutori API uses OpenAI format)
  const usage = data.usage ? {
    prompt_tokens: data.usage.prompt_tokens || 0,
    completion_tokens: data.usage.completion_tokens || 0,
    total_tokens: data.usage.total_tokens || 0
  } : undefined;
  return { response: data, ttftMs, usage };
}

// Normalize Yutori response to unified action format
// Yutori returns coordinates in 1000x1000 normalized space
function normalizeYutoriResponse(response: any, viewport: { width: number; height: number }): UnifiedAction {
  console.log('🔍 Normalizing Yutori response');
  
  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('normalizeYutoriResponse: No response content from Yutori');
  }
  
  // Parse the JSON content (handles markdown-wrapped JSON)
  let parsed: any;
  if (typeof content === 'string') {
    parsed = extractJSON(content);
    if (!parsed) {
      console.log('⚠️ Could not extract JSON from Yutori response:', content.slice(0, 300));
      throw new Error(`normalizeYutoriResponse: Could not extract JSON from Yutori response: ${content.slice(0, 200)}`);
    }
  } else {
    parsed = content;
  }
  
  const thoughts = parsed.thoughts || parsed.thinking;
  const actions = parsed.actions || [];
  
  if (actions.length === 0) {
    return {
      action: 'done',
      thinking: thoughts || 'Task complete'
    };
  }
  
  const firstAction = actions[0];
  const actionType = firstAction.action_type || 'unknown';
  
  // Convert 1000x1000 coordinates to viewport coordinates
  let coordinates: { x: number; y: number } | undefined;
  if (firstAction.center_coordinates || firstAction.coordinates) {
    const [normX, normY] = firstAction.center_coordinates || firstAction.coordinates;
    coordinates = {
      x: Math.round((normX / 1000) * viewport.width),
      y: Math.round((normY / 1000) * viewport.height)
    };
  }
  
  // Map Yutori action names to Python agent expected names
  // Yutori native actions: click, scroll, type, key_press, hover, drag, wait, refresh, go_back, goto_url, read_texts_and_links, stop
  const yutoriActionMap: Record<string, string> = {
    'type': 'input_text',
    'key_press': 'press_key',
    'go_back': 'navback',
    'goto_url': 'goto',
    'stop': 'attempt_completion',
  };
  
  const normalizedAction = yutoriActionMap[actionType] || actionType;
  
  // Validate action is one we support (Yutori has limited actions)
  // NOTE: upload_file is NOT included because yutori is a vision model that doesn't understand DOM indices.
  // When yutori tries to return upload_file, we reject it and fall back to browser-use.
  const validYutoriActions = ['click', 'scroll', 'input_text', 'press_key', 'navback', 'goto', 'wait', 'attempt_completion'];
  if (!validYutoriActions.includes(normalizedAction)) {
    throw new Error(`normalizeYutoriResponse: Unknown action "${normalizedAction}" (raw: "${actionType}") - add to yutoriActionMap or validYutoriActions`);
  }

  // Normalize Yutori params to Python agent expected format
  const normalizedParams: Record<string, any> = {};

  // Text input
  if (firstAction.typing_text) normalizedParams.text = firstAction.typing_text;
  if (firstAction.text) normalizedParams.text = firstAction.text;

  // Navigation
  if (firstAction.url) normalizedParams.url = firstAction.url;

  // File upload - filename is at top level in Yutori response
  if (firstAction.filename) normalizedParams.filename = firstAction.filename;
  if (firstAction.file_path) normalizedParams.file_path = firstAction.file_path;

  // Key presses - map 'keys' and 'key_comb' to 'key'
  // Yutori uses 'key_comb' for keyboard shortcuts (e.g., "Control+o")
  if (firstAction.key) normalizedParams.key = firstAction.key;
  if (firstAction.keys) normalizedParams.key = firstAction.keys;
  if (firstAction.key_comb) normalizedParams.key = firstAction.key_comb;
  
  // Handle scroll direction from action_type
  // Yutori returns amount in pixels directly (e.g. 300, 600)
  // Small values (<50) are likely multipliers - convert them, otherwise use directly
  const normalizeScrollAmount = (amount: number, viewportHeight: number = 800): number => {
    if (amount < 50) {
      // Small value - probably a multiplier (e.g. 3 = 3 * 100px)
      return Math.max(100, Math.round(amount * 100));
    }
    // Larger values are pixels, use directly with reasonable bounds
    return Math.min(Math.max(amount, 100), 2000);
  };
  
  if (actionType === 'scroll_up') {
    normalizedParams.direction = 'up';
    normalizedParams.amount = 300;
  } else if (actionType === 'scroll_down') {
    normalizedParams.direction = 'down';
    normalizedParams.amount = 300;
  } else if (firstAction.direction) {
    normalizedParams.direction = firstAction.direction;
    const rawAmount = firstAction.amount || 300;
    normalizedParams.amount = normalizeScrollAmount(rawAmount, viewport.height);
    console.log(`📜 Yutori scroll: raw=${firstAction.amount} → normalized=${normalizedParams.amount}px (direction=${firstAction.direction})`);
  }
  
  // Wait - Yutori might use seconds or wait_time
  if (firstAction.seconds !== undefined) {
    normalizedParams.time_ms = firstAction.seconds * 1000;
  }
  if (firstAction.wait_time !== undefined) {
    normalizedParams.time_ms = firstAction.wait_time * 1000;
  }
  
  // Add normalized coordinates for reference
  normalizedParams.normalized_coordinates = firstAction.center_coordinates || firstAction.coordinates;
  
  return {
    action: normalizedAction,
    thinking: thoughts,
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
    const cuaAction = mapToCUAAction(entry.action, entry.params);
    
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
    type: 'computer_20250124',
    name: 'computer',
    display_width_px: req.browser_state.viewport.width,
    display_height_px: req.browser_state.viewport.height,
    display_number: 1
  }];
  
  return { messages, tools };
}

// Map our action names to Anthropic CUA action format
function mapToCUAAction(action: string, params?: Record<string, any>): any {
  switch (action) {
    case 'click':
      return {
        action: 'left_click',
        coordinate: params?.coordinates ? [params.coordinates.x, params.coordinates.y] : [0, 0]
      };
    case 'type':
    case 'input_text':
      return { action: 'type', text: params?.text || '' };
    case 'scroll':
    case 'scroll_down':
      return { action: 'scroll', coordinate: [640, 400], direction: 'down', amount: 300 };
    case 'scroll_up':
      return { action: 'scroll', coordinate: [640, 400], direction: 'up', amount: 300 };
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
      console.log(`⚠️ mapToCUAAction: Unknown action "${action}" - treating as text context`);
      return null;
  }
}

// Call Anthropic CUA API
async function callAnthropicCUA(
  req: BrowserUseRequest,
  apiKey: string
): Promise<{ response: any; ttftMs: number; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const { messages, tools } = transformToAnthropicCUAFormat(req);
  
  console.log('📤 Anthropic CUA request messages count:', messages.length);
  
  const requestBody = {
    model: ANTHROPIC_CUA_MODEL,
    max_tokens: 1024,
    system: ANTHROPIC_CUA_SYSTEM_PROMPT,
    tools,
    messages
  };
  
  console.log('📤 Anthropic CUA request:', JSON.stringify(requestBody, null, 2).slice(0, 1000));
  
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
    console.error('Anthropic CUA API error:', response.status, errorText);
    throw new Error(`Anthropic CUA API error: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  console.log('📥 Anthropic CUA raw response:', JSON.stringify(data, null, 2));
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
  console.log('🔍 Normalizing Anthropic CUA response');
  
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
      // CUA's native screenshot action - we capture automatically, so skip
      return {
        action: 'done',
        thinking: textPart?.text || 'Screenshot requested (already capturing automatically)',
        params: {}
      };
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
  supabaseUrl: string
): Promise<{ response: any; ttftMs: number; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  // Check if this is a DOM-only model (no vision needed)
  const isDomOnly = DOM_ONLY_MODELS.includes(model);
  
  // transformToBrowserUseFormat already includes the dynamic system prompt
  // For DOM-only models, skip screenshot to reduce tokens and improve latency
  const { messages } = transformToBrowserUseFormat(req, { includeScreenshot: !isDomOnly });
  
  console.log(`📤 Generic LLM request to: ${model} (DOM-only: ${isDomOnly})`);
  console.log('📤 Messages count:', messages.length);
  
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
      // Request JSON response
      response_format: { type: 'json_object' }
    })
  });
  
  const ttftMs = Date.now() - startTime;
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('OpenRouter API error:', response.status, errorText);
    throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  
  // Extract the content from OpenRouter response format
  const content = data.choices?.[0]?.message?.content;
  console.log('📥 Generic LLM raw content:', content);
  
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
  console.log('🔍 Normalizing response:', JSON.stringify(response, null, 2));
  
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
    console.log('⚠️ Could not extract JSON from completion:', completion.slice(0, 300));
    throw new Error(`normalizeBrowserUseResponse: Could not extract JSON from completion: ${completion.slice(0, 200)}`);
  }
  
  // Extract action array - it could be in different places
  let actions = completion.action;
  if (!actions || actions.length === 0) {
    console.log('⚠️ No actions in completion, checking for alternative formats');
    throw new Error(`normalizeBrowserUseResponse: No actions in completion. Got: ${JSON.stringify(completion).slice(0, 300)}`);
  }
  
  const firstAction = actions[0];
  console.log('🎯 First action:', JSON.stringify(firstAction, null, 2));
  
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
  console.log(`📊 Fetching cached latencies for ${pool} (cutoff: ${cutoff})`);
  
  const { data, error } = await supabase
    .from('RoseModelLatency')
    .select('model, latencyMs, measuredAt')
    .eq('pool', pool)
    .gt('measuredAt', cutoff);
  
  const latencies = new Map<string, number>();
  if (error) {
    console.error('❌ Error fetching latency cache:', error);
    return { latencies, needsRefresh: true, missingModels: poolModels };
  }
  
  for (const entry of data || []) {
    latencies.set(entry.model, entry.latencyMs);
  }
  
  // Check which models are missing from cache
  const missingModels = poolModels.filter(model => !latencies.has(model));
  const needsRefresh = missingModels.length > 0;
  
  if (latencies.size === 0) {
    console.log(`📊 No cached latencies for ${pool} (cache empty or expired)`);
  } else {
    console.log(`📊 Cached latencies for ${pool}:`, Object.fromEntries(latencies));
    if (missingModels.length > 0) {
      console.log(`📊 Missing from cache: ${missingModels.join(', ')}`);
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
  console.log(`🔬 Firing latency probes for ${models.length} models: ${models.join(', ')}`);
  
  const probePromises = models.map(async (model) => {
    const startTime = Date.now();
    const controller = new AbortController(); // To kill the request immediately
    
    try {
      let response: globalThis.Response;
      
      // Call Anthropic directly for Claude models (same as race)
      if (isAnthropicModel(model)) {
        const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
        if (!anthropicKey) {
          console.error(`❌ Probe skipped for ${model}: no ANTHROPIC_API_KEY`);
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
        console.error(`❌ Probe failed for ${model}: ${response.status}`);
        return;
      }
      
      const reader = response.body?.getReader();
      if (!reader) {
        console.error(`❌ Probe no body for ${model}`);
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
              console.log(`🔬 Probe result: ${model} = ${ttftMs}ms (first contentful token)`);
              
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
      
      console.error(`❌ Probe no contentful data for ${model}`);
      
    } catch (error) {
      // Ignore abort errors (expected when we kill the request)
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error(`❌ Probe error for ${model}:`, error);
    }
  });
  
  // Wait for all probes to complete
  await Promise.allSettled(probePromises);
  console.log(`🔬 All latency probes completed for ${pool}`);
}

// Update latency cache for a model (upsert)
// Ignores outlier latencies (> 10s) which are likely timeouts or errors
async function updateLatencyCache(supabase: any, model: string, pool: string, latencyMs: number): Promise<void> {
  // Ignore outliers - latencies > 10s are likely timeouts or cold starts
  const MAX_VALID_LATENCY_MS = 10000;
  if (latencyMs > MAX_VALID_LATENCY_MS) {
    console.warn(`⚠️ Ignoring outlier latency for ${model}: ${latencyMs}ms > ${MAX_VALID_LATENCY_MS}ms`);
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
    console.error(`❌ Error updating latency cache for ${model}:`, error);
  } else {
    console.log(`⏱️ Updated latency cache: ${model} = ${latencyMs}ms`);
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
    console.warn(`⚠️ RPC increment failed for ${model}, trying manual update:`, error.message);
    
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
      console.log(`📉 Loser ${model}: latency incremented ${data.latencyMs} → ${newLatency}ms (less sandbagging)`);
    }
  } else {
    console.log(`📉 Loser ${model}: latency incremented by ${LOSER_LATENCY_INCREMENT_MS}ms (atomic)`);
  }
}

// ============================================
// CONVERSATION MODEL TRACKING
// ============================================

// Get existing model selection for a conversation
async function getConversationModel(supabase: any, conversationId: string): Promise<string | null> {
  console.log(`🔍 Looking up model for conversation: ${conversationId}`);
  
  const { data, error } = await supabase
    .from('RoseConversationModel')
    .select('model')
    .eq('conversationId', conversationId)
    .maybeSingle();  // Use maybeSingle to avoid error when no rows found
  
  if (error) {
    console.error(`❌ Error looking up conversation model:`, error);
    return null;
  }
  
  if (!data) {
    console.log(`📝 No existing model for conversation ${conversationId}`);
    return null;
  }
  
  console.log(`🔗 Found existing model for conversation ${conversationId}: ${data.model}`);
  return data.model;
}

// Save model selection for a conversation
async function saveConversationModel(supabase: any, conversationId: string, model: string, pool: string): Promise<void> {
  console.log(`💾 Saving model ${model} for conversation ${conversationId}`);
  
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
    console.error(`❌ Error saving conversation model:`, error);
  } else {
    console.log(`✅ Saved model for conversation ${conversationId}: ${model}`);
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

// Select a random trio from the pool, calculate delays based on cached latencies
// 
// Strategy: 
// 1. First, exclude models with latency > 3s (hard cap)
// 2. Group remaining models by latency bands (within 1000ms of each other)
// 3. Prefer the fastest band, randomly select trio from that band
// 4. Add delays to fast models so they finish at same time as the slowest in the trio
function selectRacingTrio(
  pool: string[],
  cachedLatencies: Map<string, number>
): RacingModel[] {
  const DEFAULT_LATENCY_MS = 500;
  
  // Get all models with their latencies
  const modelsWithLatency = pool.map(model => ({
    model,
    latencyMs: cachedLatencies.get(model) || DEFAULT_LATENCY_MS
  }));
  
  // Filter out models exceeding hard latency cap (3s)
  const underHardCap = modelsWithLatency.filter(m => {
    if (m.latencyMs > MAX_LATENCY_CAP_MS) {
      console.warn(`⚠️ Excluding ${m.model} - latency ${m.latencyMs}ms exceeds ${MAX_LATENCY_CAP_MS}ms cap`);
      return false;
    }
    return true;
  });
  
  if (underHardCap.length === 0) {
    console.warn('⚠️ No eligible models after 3s cap, using full pool with fastest models');
    const sorted = modelsWithLatency.sort((a, b) => a.latencyMs - b.latencyMs);
    return sorted.slice(0, TRIO_SIZE).map(m => ({ ...m, delayMs: 0 }));
  }
  
  // Sort by latency (fastest first)
  underHardCap.sort((a, b) => a.latencyMs - b.latencyMs);
  
  // Find models within MAX_DELAY_CAP_MS of the fastest model
  // This ensures no model needs more than 1s delay
  const fastestLatency = underHardCap[0].latencyMs;
  const withinDelayCap = underHardCap.filter(m => 
    (m.latencyMs - fastestLatency) <= MAX_DELAY_CAP_MS
  );
  
  // Log what we excluded due to delay cap
  const excludedByDelay = underHardCap.filter(m => 
    (m.latencyMs - fastestLatency) > MAX_DELAY_CAP_MS
  );
  for (const m of excludedByDelay) {
    console.warn(`⚠️ Excluding ${m.model} - latency ${m.latencyMs}ms is ${m.latencyMs - fastestLatency}ms slower than fastest (${fastestLatency}ms), exceeds ${MAX_DELAY_CAP_MS}ms delay cap`);
  }
  
  // ALWAYS include the fastest model, then randomly select the rest
  // This ensures we don't accidentally exclude a fast model for complex payloads
  const fastestModel = withinDelayCap[0];  // Already sorted, index 0 is fastest
  const otherModels = withinDelayCap.slice(1);
  
  // Shuffle the rest and pick TRIO_SIZE - 1
  const shuffledOthers = [...otherModels].sort(() => Math.random() - 0.5);
  const randomOthers = shuffledOthers.slice(0, Math.min(TRIO_SIZE - 1, shuffledOthers.length));
  
  // Combine: fastest + random others
  const selectedModels = [fastestModel, ...randomOthers];
  console.log(`🏁 Trio: fastest=${fastestModel.model}, others=[${randomOthers.map(m => m.model).join(', ')}]`);
  
  // Find the slowest model in the selected trio
  const slowestInTrio = Math.max(...selectedModels.map(m => m.latencyMs));
  
  // Calculate delays: fast models wait so all finish ~simultaneously
  const racingModels: RacingModel[] = selectedModels.map(m => ({
    model: m.model,
    latencyMs: m.latencyMs,
    delayMs: slowestInTrio - m.latencyMs
  }));
  
  console.log(`🏁 Racing trio (target finish ~${slowestInTrio}ms):`, 
    racingModels.map(m => `${m.model} (${m.latencyMs}ms + ${m.delayMs}ms delay = ${m.latencyMs + m.delayMs}ms)`));
  
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
  
  console.log(`🏁 Starting race with ${racingModels.length} models:`, racingModels.map(m => `${m.model} (delay: ${m.delayMs}ms)`));
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
        console.log(`⏳ ${model} waiting ${delayMs}ms before firing...`);
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
        console.log(`🛑 ${model} aborted before firing`);
        return null;
      }
      
      const startTime = Date.now();
      timings[`${modelKey}_fire`] = Date.now() - raceInternalStart;
      console.log(`🚀 ${model} firing request at t=${timings[`${modelKey}_fire`]}ms...`);
      
      // Get model-specific messages (transforms screenshots for vision models)
      const modelMessages = getMessagesForModel(messages, model);
      
      let response: globalThis.Response;
      
      // Call Anthropic directly for Claude models (structured outputs require beta header)
      if (isAnthropicModel(model)) {
        const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
        if (!anthropicKey) {
          console.error(`❌ ${model} requires ANTHROPIC_API_KEY`);
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
          anthropicBody.system = system;
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
        
        console.log(`🔮 Calling Anthropic directly for ${anthropicModel}`);
        console.log(`[Anthropic Race] Request to ${anthropicModel}:`, JSON.stringify(truncateForLogging(anthropicBody), null, 2));
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

        console.log(`[OpenRouter Race] Request to ${model}:`, JSON.stringify(truncateForLogging(body), null, 2));

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
      console.log(`📨 ${model} headers in ${headersTime}ms at t=${timings[`${modelKey}_headers`]}ms (status: ${response.status})`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ ${model} failed: ${response.status} - ${errorText}`);
        return null;
      }
      
      // CRITICAL: Wait for FIRST ACTUAL DATA, not just headers!
      // This prevents slow models from winning just because their headers arrive first
      const reader = response.body?.getReader();
      if (!reader) {
        console.error(`❌ ${model} no response body`);
        return null;
      }
      
      const decoder = new TextDecoder();
      let buffer = '';  // For parsing - holds incomplete line
      let allData = ''; // Accumulate ALL data for firstData (needed for Anthropic message_start)

      // Read until we get a real data line (not just ": OPENROUTER PROCESSING")
      while (true) {
        // Check if aborted while waiting for content
        if (controllers[index].signal.aborted) {
          console.log(`🛑 ${model} aborted while waiting for content`);
          reader.cancel();
          return null;
        }

        const { done, value } = await reader.read();
        if (done) {
          console.error(`❌ ${model} stream ended before data`);
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
                  console.log(`✅ ${model} FIRST CONTENTFUL TOKEN in ${ttftMs}ms at t=${timings[`${modelKey}_first_data`]}ms`);

                  // IMMEDIATELY abort all other racing models to save API costs
                  // Don't wait for promise resolution - kill them NOW
                  controllers.forEach((controller, i) => {
                    if (i !== index) {
                      console.log(`🛑 Immediately aborting loser: ${racingModels[i].model}`);
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
        console.log(`🛑 ${model} aborted (race lost)`);
        return null;
      }
      console.error(`❌ ${model} error:`, error);
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
          console.log(`🏆 Winner: ${result.model} (TTFT: ${result.ttftMs}ms)`);
          
          // Losers already aborted inline when winner found contentful token
          // Just update loser latencies (fire-and-forget)
          controllers.forEach((controller, i) => {
            if (i !== winnerIndex) {
              // Increment loser's latency by 10ms (reduces sandbagging, gives them better chance next race)
              incrementLoserLatency(supabase, racingModels[i].model, pool)
                .catch(e => console.error(`⚠️ Failed to increment loser latency:`, e));
            }
          });
          
          // Update cache for winning model with actual race TTFT (keeps cache fresh)
          updateLatencyCache(supabase, result.model, pool, result.ttftMs)
            .then(() => console.log(`📝 Cache updated for winner: ${result.model} = ${result.ttftMs}ms`))
            .catch(e => console.error(`⚠️ Failed to update winner cache:`, e));
          
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

// Map OpenRouter model names to Anthropic model names
function getAnthropicModelName(openRouterModel: string): string {
  const mapping: Record<string, string> = {
    'anthropic/claude-haiku-4.5': 'claude-haiku-4-5',
    'anthropic/claude-sonnet-4.5': 'claude-sonnet-4-5',
    'anthropic/claude-sonnet-4': 'claude-sonnet-4-20250514',
    'anthropic/claude-opus-4': 'claude-opus-4-20250514',
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
    console.log(`⚡ Model selection (preference=${modelPreference}): ${requestedModel} → ${preference.model} (Cerebras: ${preference.isCerebras})`);
    return { model: preference.model, isCerebras: preference.isCerebras, poolName: normalized, poolSize: pool.length };
  }
  
  // If model_seed is provided, use it to select a specific model
  if (modelSeed !== undefined) {
    if (modelSeed < 0 || modelSeed >= pool.length) {
      throw new Error(`model_seed ${modelSeed} out of range. Pool '${normalized}' has ${pool.length} models (valid range: 0-${pool.length - 1})`);
    }
    const selectedModel = pool[modelSeed];
    console.log(`🎯 Model selection (seed=${modelSeed}): ${requestedModel} → ${selectedModel} (Cerebras: false)`);
    return { model: selectedModel, isCerebras: false, poolName: normalized, poolSize: pool.length };
  }
  
  // Random selection from pool
  const selectedModel = pool[Math.floor(Math.random() * pool.length)];
  console.log(`🎲 Model selection: ${requestedModel} → ${selectedModel} (Cerebras: false)`);
  return { model: selectedModel, isCerebras: false, poolName: normalized, poolSize: pool.length };
}

// Validate API key and return user info
async function validateApiKey(apiKey: string, supabase: any): Promise<{ apiKeyId: string, userId: string } | null> {
  console.log('🔍 Validating API key:', apiKey.substring(0, 8) + '...');
  
  const { data, error } = await supabase
    .from('RoseApiKey')
    .select('id, userId')
    .eq('apiKey', apiKey)
    .single();
  
  if (error || !data) {
    console.error('❌ API key validation failed:', error?.message || 'No data found');
    console.error('   Error details:', error);
    return null;
  }
  
  console.log('✓ API key validated for userId:', data.userId);
  return { apiKeyId: data.id, userId: data.userId };
}

// Calculate cost based on token usage
function calculateCost(promptTokens: number, completionTokens: number, model: string): number {
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
    console.error('Failed to log usage:', error);
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
  poolSize: number      // Added: for debugging
) {
  // Get model-specific messages (transforms screenshots for vision models)
  const modelMessages = getMessagesForModel(messages, actualModel);
  
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        let response: globalThis.Response;
        
        if (isCerebras) {
          // Call Cerebras API directly for rose-hyper
          const cerebrasKey = Deno.env.get('CEREBRAS_API_KEY');
          console.log(`⚡ Streaming from Cerebras API with model: ${actualModel}`);
          
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
          
          response = await fetch(CEREBRAS_API_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${cerebrasKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(cerebrasStreamBody)
          });
        } else if (isAnthropicModel(actualModel)) {
          // Call Anthropic API directly for Claude models (structured outputs require beta header)
          const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
          if (!anthropicKey) {
            throw new Error(`ANTHROPIC_API_KEY required for ${actualModel}`);
          }
          
          const anthropicModel = getAnthropicModelName(actualModel);
          const { system, messages: anthropicMessages } = transformMessagesForAnthropic(modelMessages);
          
          console.log(`🔮 Streaming from Anthropic API with model: ${anthropicModel}`);
          
          const anthropicBody: any = {
            model: anthropicModel,
            messages: anthropicMessages,
            max_tokens: maxTokens || 4096,
            stream: true
          };
          
          if (system) {
            anthropicBody.system = system;
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

          console.log(`[Anthropic Stream] Request to ${anthropicModel}:`, JSON.stringify(truncateForLogging(anthropicBody), null, 2));

          response = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': ANTHROPIC_BETA_HEADER,
              'content-type': 'application/json'
            },
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
            console.log(`🧠 Streaming with reasoning config:`, reasoning);
          }

          console.log(`[OpenRouter Stream] Request to ${actualModel}:`, JSON.stringify(truncateForLogging(openRouterBody), null, 2));

          response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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

        if (!response.ok) {
          const provider = isCerebras ? 'Cerebras' : isAnthropicModel(actualModel) ? 'Anthropic' : 'OpenRouter';
          // Read error body for better debugging
          const errorText = await response.text();
          console.error(`${provider} streaming error:`, response.status, errorText);
          throw new Error(`${provider} API error: ${response.status} - ${errorText.slice(0, 200)}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        // Anthropic usage tracking - capture from message_start and message_delta
        let anthropicInputTokens = 0;
        let anthropicOutputTokens = 0;

        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            // For Anthropic models, emit final usage chunk before [DONE]
            if (isAnthropicModel(actualModel) && (anthropicInputTokens > 0 || anthropicOutputTokens > 0)) {
              const usageChunk = {
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop'
                }],
                usage: {
                  prompt_tokens: anthropicInputTokens,
                  completion_tokens: anthropicOutputTokens,
                  total_tokens: anthropicInputTokens + anthropicOutputTokens
                },
                requested_model: requestedModel,
                actual_model: actualModel,
                pool_name: poolName,
                pool_size: poolSize
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
              console.log(`📊 Anthropic usage emitted: input=${anthropicInputTokens}, output=${anthropicOutputTokens}`);
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
                if (isAnthropicModel(actualModel)) {
                  // Capture input tokens from message_start
                  if (parsed.type === 'message_start' && parsed.message?.usage?.input_tokens) {
                    anthropicInputTokens = parsed.message.usage.input_tokens;
                    console.log(`📊 Anthropic input_tokens captured: ${anthropicInputTokens}`);
                    continue;
                  }

                  // Capture output tokens from message_delta
                  if (parsed.type === 'message_delta' && parsed.usage?.output_tokens) {
                    anthropicOutputTokens = parsed.usage.output_tokens;
                    console.log(`📊 Anthropic output_tokens captured: ${anthropicOutputTokens}`);
                    continue;
                  }

                  // Skip other non-content events
                  if (parsed.type !== 'content_block_delta') {
                    continue;
                  }

                  // Transform to OpenAI format
                  // Handle both delta.text (normal) and delta.partial_json (JSON schema output)
                  const openAIFormat = {
                    choices: [{
                      index: 0,
                      delta: {
                        content: parsed.delta?.text || parsed.delta?.partial_json || ''
                      }
                    }],
                    requested_model: requestedModel,
                    actual_model: actualModel,
                    pool_name: poolName,
                    pool_size: poolSize
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIFormat)}\n\n`));
                } else {
                  // OpenRouter/Cerebras - pass through with metadata
                  parsed.requested_model = requestedModel;
                  parsed.actual_model = actualModel;
                  parsed.pool_name = poolName;
                  parsed.pool_size = poolSize;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
                }
              } catch (e) {
                console.error('Error parsing streaming data:', e);
              }
            } else if (line.startsWith('event: ')) {
              // Anthropic uses separate event lines - skip them (data follows)
              continue;
            }
          }
        }
      } catch (error) {
        console.error('Streaming error:', error);
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

  try {
    // Extract API key from header
    const apiKey = req.headers.get('x-api-key');
    if (!apiKey) {
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
    const authInfo = await validateApiKey(apiKey, supabase);
    if (!authInfo) {
      return new Response(JSON.stringify({ error: 'Invalid API key' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    // Parse request body (raw first for browser-use detection)
    const rawBody = await req.json();
    
    // ============================================
    // HANDLE BROWSER-USE REQUESTS (EARLY)
    // Browser-use has different format: task + browser_state instead of messages
    // ============================================
    if (isBrowserUseRequest(rawBody)) {
      console.log(`🌐 Browser-use request detected for model: ${rawBody.model}`);
      const browserUseReq = rawBody as BrowserUseRequest;

      // Tracing: log action_history details
      console.log('🔍 [TRACE] action_history count:', browserUseReq.action_history.length);
      if (browserUseReq.action_history.length > 0) {
        const lastAction = browserUseReq.action_history[browserUseReq.action_history.length - 1];
        console.log('🔍 [TRACE] Last action:', {
          action: lastAction.action,
          hasThinking: !!lastAction.thinking,
          hasScreenshot: !!lastAction.screenshot,
          thinkingPreview: lastAction.thinking?.slice(0, 100)
        });
      }

      // Tracing: log screenshot metadata
      if (browserUseReq.browser_state.screenshot) {
        console.log('📸 [SCREENSHOT] Rose API received', {
          viewport: `${browserUseReq.browser_state.viewport.width}x${browserUseReq.browser_state.viewport.height}`,
          screenshotChars: browserUseReq.browser_state.screenshot.length,
          isBase64: !browserUseReq.browser_state.screenshot.startsWith('http')
        });
      }
      
      // Get the browser-use pool
      const browserPool = MODEL_POOLS['rose-1-browser-use'];
      if (!browserPool) {
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
        providerIndex: number
      ): Promise<{ action: UnifiedAction; ttftMs: number; actualModel: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
        // Log the full request (with truncated screenshots)
        console.log(`\n📤 [${provider}] FULL REQUEST:`);
        console.log(JSON.stringify(truncateForLogging({
          provider,
          providerIndex,
          task: browserUseReq.task,
          browser_state: browserUseReq.browser_state,
          action_history: browserUseReq.action_history,
          model_seed: browserUseReq.model_seed,
        }), null, 2));

        if (provider === 'browser-use') {
          const browserUseApiKey = Deno.env.get('BROWSER_USE_API_KEY');
          if (!browserUseApiKey) throw new Error('BROWSER_USE_API_KEY not configured');

          const result = await callBrowserUseLLM(browserUseReq, browserUseApiKey);
          const normalizedAction = normalizeBrowserUseResponse(result.response);

          console.log(`\n📥 [${provider}] FULL RESPONSE:`);
          console.log(JSON.stringify(truncateForLogging(result.response), null, 2));
          console.log(`\n🔄 [${provider}] NORMALIZED ACTION:`);
          console.log(JSON.stringify(normalizedAction, null, 2));

          return {
            action: normalizedAction,
            ttftMs: result.ttftMs,
            actualModel: 'browser-use/bu-1-0',
            usage: result.usage
          };

        } else if (provider === 'yutori/n1') {
          const yutoriApiKey = Deno.env.get('YUTORI_API_KEY');
          if (!yutoriApiKey) throw new Error('YUTORI_API_KEY not configured');
          if (!browserUseReq.browser_state.screenshot) {
            throw new Error('Yutori requires screenshot');
          }

          const result = await callYutoriLLM(browserUseReq, yutoriApiKey);

          console.log(`\n📥 [${provider}] FULL RESPONSE:`);
          console.log(JSON.stringify(truncateForLogging(result.response), null, 2));

          const normalizedAction = normalizeYutoriResponse(result.response, browserUseReq.browser_state.viewport);

          console.log(`\n🔄 [${provider}] NORMALIZED ACTION:`);
          console.log(JSON.stringify(normalizedAction, null, 2));

          return {
            action: normalizedAction,
            ttftMs: result.ttftMs,
            actualModel: 'yutori/n1-preview-2025-11',
            usage: result.usage
          };

        } else if (provider === 'anthropic/claude-cua') {
          const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY');
          if (!anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not configured');
          if (browserUseReq.browser_state.screenshot?.startsWith('http')) {
            throw new Error('Anthropic CUA requires base64 screenshot');
          }

          const result = await callAnthropicCUA(browserUseReq, anthropicApiKey);

          console.log(`\n📥 [${provider}] FULL RESPONSE:`);
          console.log(JSON.stringify(truncateForLogging(result.response), null, 2));

          const normalizedAction = normalizeAnthropicCUAResponse(result.response);

          console.log(`\n🔄 [${provider}] NORMALIZED ACTION:`);
          console.log(JSON.stringify(normalizedAction, null, 2));

          return {
            action: normalizedAction,
            ttftMs: result.ttftMs,
            actualModel: 'anthropic/claude-sonnet-4-cua',
            usage: result.usage
          };

        } else {
          // Generic LLM via OpenRouter
          const openRouterKey = Deno.env.get('OPENROUTER_API_KEY');
          if (!openRouterKey) throw new Error('OPENROUTER_API_KEY not configured');

          const result = await callGenericLLM(browserUseReq, provider, openRouterKey, supabaseUrl);

          console.log(`\n📥 [${provider}] FULL RESPONSE:`);
          console.log(JSON.stringify(truncateForLogging(result.response), null, 2));

          const normalizedAction = normalizeBrowserUseResponse(result.response);

          console.log(`\n🔄 [${provider}] NORMALIZED ACTION:`);
          console.log(JSON.stringify(normalizedAction, null, 2));

          return {
            action: normalizedAction,
            ttftMs: result.ttftMs,
            actualModel: provider,
            usage: result.usage
          };
        }
      }
      
      // ============================================
      // MODE 1: model_seed provided - direct call to specific provider (for testing)
      // ============================================
      if (browserUseReq.model_seed !== undefined) {
        const providerIndex = browserUseReq.model_seed;
        
        if (providerIndex < 0 || providerIndex >= browserPool.length) {
          return new Response(JSON.stringify({ 
            error: `model_seed ${providerIndex} out of range. Pool has ${browserPool.length} providers (0-${browserPool.length - 1})` 
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 400,
          });
        }
        
        const selectedProvider = browserPool[providerIndex];
        console.log(`🎯 Browser-use provider (seeded): ${selectedProvider} (index: ${providerIndex})`);
        
        try {
          const result = await callProvider(selectedProvider, providerIndex);

          console.log(`✅ Browser-use response: action=${result.action.action}, index=${result.action.index}`);

          return new Response(JSON.stringify({
            action: result.action,
            requested_model: browserUseReq.model,
            actual_model: result.actualModel,
            pool_name: 'rose-1-browser-use',
            pool_size: browserPool.length,
            provider_index: providerIndex,
            ttft_ms: result.ttftMs,
            usage: result.usage,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
          });

        } catch (error) {
          console.error(`❌ Browser-use (seeded) failed:`, error);
          return new Response(JSON.stringify({ 
            error: 'Browser-use request failed',
            details: error instanceof Error ? error.message : 'Unknown error'
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 500,
          });
        }
      }
      
      // ============================================
      // MODE 2: No model_seed - random rotation with 5s timeout + fallback
      // ============================================
      const providerOrder = shuffleArray([...Array(browserPool.length).keys()]);
      console.log(`🎲 Browser-use provider order: ${providerOrder.map(i => browserPool[i]).join(' → ')}`);
      
      let lastError = '';
      
      for (const providerIndex of providerOrder) {
        const selectedProvider = browserPool[providerIndex];
        console.log(`🎯 Trying: ${selectedProvider} (${BROWSER_USE_TIMEOUT_MS}ms timeout)`);
        
        try {
          const result = await withTimeout(
            callProvider(selectedProvider, providerIndex),
            BROWSER_USE_TIMEOUT_MS,
            selectedProvider
          );

          console.log(`✅ Browser-use response: action=${result.action.action}, index=${result.action.index}`);

          return new Response(JSON.stringify({
            action: result.action,
            requested_model: browserUseReq.model,
            actual_model: result.actualModel,
            pool_name: 'rose-1-browser-use',
            pool_size: browserPool.length,
            provider_index: providerIndex,
            ttft_ms: result.ttftMs,
            usage: result.usage,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
          });

        } catch (error) {
          lastError = error instanceof Error ? error.message : 'Unknown error';
          console.log(`⏱️ ${selectedProvider} failed: ${lastError}, trying next...`);
          continue;
        }
      }
      
      // All providers failed
      console.error(`❌ All browser-use providers failed. Last error: ${lastError}`);
      return new Response(JSON.stringify({ 
        error: 'All browser-use providers failed or timed out',
        last_error: lastError
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      });
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
      ...otherParams
    } = rawBody;
    
    const cotSteps = cot_steps || 1;
    const maxTokens = max_tokens;
    let messages = originalMessages;

    // Log incoming messages for debugging
    console.log(`[Rose Completions] Received ${messages?.length || 0} messages:`, JSON.stringify(truncateForLogging(messages), null, 2));

    // Default reasoning tokens to 256 if reasoning is enabled but no max_tokens specified
    const DEFAULT_REASONING_TOKENS = 256;
    let cappedReasoning = reasoning;
    if (reasoning && !reasoning.max_tokens) {
      cappedReasoning = { ...reasoning, max_tokens: DEFAULT_REASONING_TOKENS };
      console.log(`🧠 Setting default reasoning tokens: ${DEFAULT_REASONING_TOKENS}`);
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
      console.log(`🔧 Direct model passthrough: ${model}`);
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
        console.error('OpenRouter API error:', response.status, errorText);
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
          selection.poolSize
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
        console.log(`🔗 Using existing model for conversation: ${existingModel}`);
        
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
            pool.length
          );
        }
        
        selectedModel = existingModel;
        selectedIsCerebras = false;
      }
    }

    // Handle streaming with trio racing
    if (stream && !selectedModel) {
      const openRouterKey = Deno.env.get('OPENROUTER_API_KEY')!;
      
      // ===== TIMING INSTRUMENTATION =====
      const timings: { [key: string]: number } = {};
      const raceStartTime = Date.now();
      timings.race_start = 0;
      
      // Get cached latencies for this pool
      const cacheStartTime = Date.now();
      const { latencies: cachedLatencies, needsRefresh, missingModels } = await getCachedLatencies(supabase, poolName, pool);
      timings.cache_lookup_ms = Date.now() - cacheStartTime;
      console.log(`⏱️ TIMING: cache_lookup=${timings.cache_lookup_ms}ms`);
      
      // If cache is stale/missing, fire latency probes in PARALLEL with the race
      // Probes use a standard test prompt, not the user's messages
      let probePromise: Promise<void> | null = null;
      if (needsRefresh && missingModels.length > 0) {
        console.log(`🔬 Cache needs refresh, firing probes in parallel for: ${missingModels.join(', ')}`);
        // Fire probes in background - don't await, let them run alongside the race
        probePromise = fireLatencyProbes(missingModels, poolName, openRouterKey, supabaseUrl, supabase);
        timings.probes_fired = missingModels.length;
      } else {
        timings.probes_fired = 0;
      }
      
      // Filter out Anthropic models if schema has 9+ tool types (Anthropic limit is 8 anyOf branches)
      let effectivePool = pool;
      if (response_format) {
        const toolCount = countToolTypes(response_format);
        if (toolCount >= ANTHROPIC_MAX_ANYOF_BRANCHES + 1) {
          const anthropicModels = pool.filter(m => isAnthropicModel(m));
          if (anthropicModels.length > 0) {
            console.log(`⚠️ Schema has ${toolCount} tool types (limit: ${ANTHROPIC_MAX_ANYOF_BRANCHES}), excluding Anthropic models: ${anthropicModels.join(', ')}`);
            effectivePool = pool.filter(m => !isAnthropicModel(m));
          }
        }
      }

      // Filter out models that can't handle file attachments based on size
      const maxFileSize = getMaxBase64FileSizeBytes(messages);
      if (maxFileSize > 0) {
        effectivePool = filterPoolByFileSize(effectivePool, maxFileSize);
      }

      // Select racing trio with delays (using current cached values, even if stale)
      const trioSelectStart = Date.now();
      const racingTrio = selectRacingTrio(effectivePool, cachedLatencies);
      timings.trio_select_ms = Date.now() - trioSelectStart;
      console.log(`⏱️ TIMING: trio_select=${timings.trio_select_ms}ms`);
      
      if (racingTrio.length === 0) {
        return new Response(JSON.stringify({ error: 'No eligible models in pool' }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 500,
        });
      }
      
      // If only one model eligible, skip racing
      if (racingTrio.length === 1) {
        const singleModel = racingTrio[0].model;
        console.log(`🎯 Single model eligible, skipping race: ${singleModel}`);
        
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
          pool.length
        );
      }
      
      // Race the trio!
      try {
        const raceCallStart = Date.now();
        timings.race_call_start_ms = raceCallStart - raceStartTime;
        console.log(`⏱️ TIMING: race_call_start=${timings.race_call_start_ms}ms (time before raceModels)`);
        
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
        console.log(`⏱️ TIMING: race_complete=${timings.race_complete_ms}ms, race_duration=${timings.race_duration_ms}ms`);
        
        // Save winning model for conversation
        if (conversation_id) {
          await saveConversationModel(supabase, conversation_id, winningModel, poolName);
        }
        
        // Stream the winning response to client
        const encoder = new TextEncoder();
        const modelsRaced = racingTrio.length;
        const streamStartTime = Date.now();
        timings.stream_start_ms = streamStartTime - raceStartTime;
        console.log(`⏱️ TIMING: stream_start=${timings.stream_start_ms}ms`);
        
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

              // Process the firstData buffer immediately
              console.log(`⏱️ TIMING: processing firstData buffer (${firstData.length} chars)`);

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
                      // Capture input tokens from message_start
                      if (parsed.type === 'message_start') {
                        if (parsed.message?.usage?.input_tokens) {
                          anthropicInputTokens = parsed.message.usage.input_tokens;
                          console.log(`📊 Anthropic input_tokens captured: ${anthropicInputTokens}`);
                        }
                        return;
                      }

                      // Capture output tokens from message_delta
                      if (parsed.type === 'message_delta' && parsed.usage?.output_tokens) {
                        anthropicOutputTokens = parsed.usage.output_tokens;
                        console.log(`📊 Anthropic output_tokens captured: ${anthropicOutputTokens}`);
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
                        models_raced: modelsRaced
                      };

                      // Track first enqueue timing
                      if (firstEnqueueTime === null) {
                        firstEnqueueTime = Date.now() - streamStartTime;
                        timings.first_enqueue_to_client_ms = firstEnqueueTime;
                        console.log(`⏱️ TIMING: first_enqueue_to_client=${firstEnqueueTime}ms`);
                      }
                      openAIFormat.timings = timings;

                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIFormat)}\n\n`));
                      return;
                    }

                    // Non-Anthropic models (OpenRouter/Cerebras) - pass through with metadata
                    parsed.requested_model = model;
                    parsed.actual_model = winningModel;
                    parsed.pool_name = poolName;
                    parsed.pool_size = pool.length;
                    parsed.racing_ttft_ms = ttftMs;
                    parsed.models_raced = modelsRaced;

                    // Track first enqueue timing
                    if (firstEnqueueTime === null) {
                      firstEnqueueTime = Date.now() - streamStartTime;
                      timings.first_enqueue_to_client_ms = firstEnqueueTime;
                      console.log(`⏱️ TIMING: first_enqueue_to_client=${firstEnqueueTime}ms`);
                    }
                    parsed.timings = timings;

                    // Adjust usage to reflect TRUE cost (all racing models consumed input tokens)
                    if (parsed.usage && parsed.usage.prompt_tokens) {
                      const winnerPromptTokens = parsed.usage.prompt_tokens;
                      const winnerCompletionTokens = parsed.usage.completion_tokens || 0;
                      parsed.usage.prompt_tokens = winnerPromptTokens * modelsRaced;
                      parsed.usage.total_tokens = parsed.usage.prompt_tokens + winnerCompletionTokens;
                      console.log(`📊 Usage adjusted: ${winnerPromptTokens} input × ${modelsRaced} models = ${parsed.usage.prompt_tokens} total input tokens`);
                    }

                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
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
                        total_tokens: adjustedInputTokens + anthropicOutputTokens
                      },
                      requested_model: model,
                      actual_model: winningModel,
                      pool_name: poolName,
                      pool_size: pool.length,
                      racing_ttft_ms: ttftMs,
                      models_raced: modelsRaced,
                      timings
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
                    console.log(`📊 Anthropic usage adjusted: ${anthropicInputTokens} input × ${modelsRaced} models = ${adjustedInputTokens} total input tokens`);
                  }
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
              console.error('Streaming race winner error:', error);
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
        console.error('❌ Trio racing failed:', error);
        
        // Fallback to random model
        const fallbackModel = pool[Math.floor(Math.random() * pool.length)];
        console.log(`🔄 Falling back to random model: ${fallbackModel}`);
        
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
          pool.length
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
        console.log(`⚡ Calling Cerebras API with model: ${actualModel}`);
        
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
        
        console.log(`📤 Cerebras request body:`, JSON.stringify(truncateForLogging(cerebrasBody), null, 2));
        
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
        console.error(`${provider} API error:`, apiResponse.status, errorText);
        console.error(`Request body was:`, JSON.stringify(requestBody, null, 2));
        
        // Try to parse error for more details
        let errorDetails = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorDetails = JSON.stringify(errorJson, null, 2);
          console.error(`${provider} error details:`, errorJson);
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
          console.error(`${provider} API error in CoT step:`, stepResponse.status, errorText);
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
        console.error(`${provider} API error in final step:`, finalApiResponse.status, errorText);
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
    return new Response(JSON.stringify(finalResponse), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    console.error('Rose completions endpoint error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      details: errorMessage 
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});

