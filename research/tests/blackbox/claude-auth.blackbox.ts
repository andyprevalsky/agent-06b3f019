/**
 * Blackbox tests for claudeAuth pathway through POST /completions.
 *
 * These tests verify the full round-trip: real Claude OAuth token from macOS
 * keychain → research completions endpoint → Anthropic API → streaming SSE
 * with actual_model containing "-claude" suffix.
 *
 * Uses the real 11-tool execute-phase schema that exceeds Anthropic's 8 anyOf
 * branch limit for structured output, forcing the native-tools code path.
 *
 * Requires: macOS keychain with "Claude Code-credentials" entry.
 * Skips gracefully in CI or environments without keychain access.
 *
 * Run: bash research/scripts/run-blackbox-tests.sh claude-auth
 */

import {
  assertEquals,
  assertExists,
  assertNotEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.190.0/testing/asserts.ts';
import { cleanupTestData, getTestJwt, getTestUserId, seedApiKey } from './helpers.ts';

const BASE_URL = Deno.env.get('BASE_URL') ||
  `http://localhost:${Deno.env.get('RESEARCH_PORT') || '54321'}/functions/v1`;
const COMPLETIONS_URL = `${BASE_URL}/completions`;

// ---------------------------------------------------------------------------
// Claude token from macOS keychain
// ---------------------------------------------------------------------------

function getClaudeTokenFromKeychain(): string | null {
  try {
    const cmd = new Deno.Command('security', {
      args: ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      stdout: 'piped',
      stderr: 'piped',
    });
    const { code, stdout } = cmd.outputSync();
    if (code !== 0) return null;
    const raw = new TextDecoder().decode(stdout).trim();
    const parsed = JSON.parse(raw);
    return parsed.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

let _claudeToken: string | null | undefined;

function getClaudeToken(): string | null {
  if (_claudeToken === undefined) {
    _claudeToken = getClaudeTokenFromKeychain();
  }
  return _claudeToken;
}

// ---------------------------------------------------------------------------
// API key (reuse helpers pattern)
// ---------------------------------------------------------------------------

let _apiKey: string | null = null;

async function getApiKey(): Promise<string | null> {
  const envKey = Deno.env.get('ROSE_API_KEY') || Deno.env.get('ROSELABS_API_KEY');
  if (envKey) return envKey;
  if (_apiKey !== null) return _apiKey;
  try {
    await getTestJwt();
    const userId = getTestUserId();
    const { apiKey } = await seedApiKey(userId, 'bbx-claude-auth');
    _apiKey = apiKey;
    return _apiKey;
  } catch (e) {
    console.log(`Failed to obtain API key: ${e}`);
    return null;
  }
}

function ah(k: string): Record<string, string> {
  return { 'x-api-key': k };
}

// ---------------------------------------------------------------------------
// Full 11-tool execute-phase schema (real production payload)
// ---------------------------------------------------------------------------

const EXECUTE_SCHEMA = {
  type: 'object',
  properties: {
    response: {
      type: 'string',
      description: 'Thinking/reasoning about what to do next.',
    },
    tool_calls: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              tool: { type: 'string', const: 'web_search' },
              query: { type: 'string', description: 'Search query' },
            },
            required: ['tool', 'query'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              tool: { type: 'string', const: 'web_fetch' },
              url: { type: 'string', description: 'URL to fetch' },
              prompt: { type: 'string', description: 'What to extract' },
            },
            required: ['tool', 'url', 'prompt'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              tool: { type: 'string', const: 'attempt_completion' },
              result: { type: 'string', description: 'Final result' },
            },
            required: ['tool', 'result'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              tool: { type: 'string', const: 'send_message_to_user_execute_phase' },
              message: { type: 'string', description: 'Message to user' },
              is_question: { type: 'boolean', description: 'Whether this requires a response' },
            },
            required: ['tool', 'message', 'is_question'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              tool: { type: 'string', const: 'wait_seconds' },
              seconds: { type: 'number', description: 'Seconds to wait' },
              reason: { type: 'string', description: 'Why waiting' },
            },
            required: ['tool', 'seconds', 'reason'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              tool: { type: 'string', const: 'spawn_browser_agent' },
              url: { type: 'string', description: 'URL to navigate to' },
              task: { type: 'string', description: 'Task for browser agent' },
            },
            required: ['tool', 'url', 'task'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              tool: { type: 'string', const: 'spawn_claude_code_agent' },
              task: { type: 'string', description: 'Coding task' },
              repo_url: { type: 'string', description: 'Repository URL' },
            },
            required: ['tool', 'task', 'repo_url'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              tool: { type: 'string', const: 'spawn_sub_agent' },
              goal: { type: 'string', description: 'Sub-agent goal' },
            },
            required: ['tool', 'goal'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              tool: { type: 'string', const: 'people_search' },
              query: { type: 'string', description: 'Search query for people' },
            },
            required: ['tool', 'query'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              tool: { type: 'string', const: 'call_phone_number' },
              phone_number: { type: 'string', description: 'Phone number' },
              prompt: { type: 'string', description: 'Call prompt' },
            },
            required: ['tool', 'phone_number', 'prompt'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              tool: { type: 'string', const: 'send_sms_as_user' },
              phone_number: { type: 'string', description: 'Phone number' },
              message: { type: 'string', description: 'SMS message' },
            },
            required: ['tool', 'phone_number', 'message'],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ['response', 'tool_calls'],
  additionalProperties: false,
};

const responseFormat = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'AgentAction',
    schema: EXECUTE_SCHEMA,
    strict: true,
  },
};

const sampleMessages = [
  {
    role: 'system' as const,
    content:
      "You are a helpful agent. Respond with a brief thought in the response field, then call web_search to search for 'weather in San Francisco today'.",
  },
  {
    role: 'user' as const,
    content: "What's the weather like in San Francisco right now?",
  },
];

// ---------------------------------------------------------------------------
// SSE stream reader
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
async function readStream(res: Response, maxChunks = 200): Promise<{ fullText: string; chunks: any[] }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  // deno-lint-ignore no-explicit-any
  const chunks: any[] = [];
  let n = 0;
  try {
    while (n < maxChunks) {
      const { done, value } = await reader.read();
      if (done) break;
      fullText += decoder.decode(value, { stream: true });
      n++;
    }
  } catch {
    // Connection may drop mid-stream (e.g. expired token, upstream timeout).
    // Return whatever we've read so far — caller decides if it's enough.
  } finally {
    try { reader.cancel(); } catch { /* already closed */ }
  }
  for (const line of fullText.split('\n')) {
    if (line.startsWith('data:') && !line.includes('[DONE]')) {
      const js = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
      try {
        chunks.push(JSON.parse(js.trim()));
      } catch { /* partial chunk */ }
    }
  }
  return { fullText, chunks };
}

function skipNoClaude(): boolean {
  if (!getClaudeToken()) {
    console.log('SKIP: No Claude token in keychain (not on macOS or credentials missing)');
    return true;
  }
  return false;
}

function skipNoKey(k: string | null): boolean {
  if (!k) {
    console.log('SKIP: No API key');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: 'claudeAuth: streaming with real token routes through Anthropic (actual_model has -claude suffix)',
  fn: async () => {
    if (skipNoClaude()) return;
    const k = await getApiKey();
    if (skipNoKey(k)) return;

    const token = getClaudeToken()!;

    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ah(k!) },
      body: JSON.stringify({
        model: 'rose-labs/rose-1-lite',
        claude_token: token,
        messages: sampleMessages,
        max_tokens: 1024,
        stream: true,
        stream_options: { include_usage: true },
        response_format: responseFormat,
      }),
    });

    assertNotEquals(res.status, 401, 'Auth must pass with valid API key');
    assertNotEquals(res.status, 400, 'Validation must pass with valid payload');
    assertEquals(res.status, 200, `Expected 200 but got ${res.status}: ${await res.clone().text()}`);

    const { fullText, chunks } = await readStream(res);

    // Must have SSE data
    assertEquals(fullText.includes('data:'), true, 'Response must contain SSE data lines');
    assertEquals(chunks.length > 0, true, 'Must have at least one parsed chunk');

    // actual_model must contain -claude suffix (proves routing through Anthropic via claudeAuth)
    const modelsInChunks = chunks
      .map((c) => c.actual_model)
      .filter(Boolean);
    assertEquals(modelsInChunks.length > 0, true, 'At least one chunk must have actual_model');
    for (const model of modelsInChunks) {
      assertStringIncludes(
        model,
        '-claude',
        `actual_model "${model}" must contain "-claude" suffix (proves claudeAuth routing)`,
      );
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: 'claudeAuth: streamed content is valid JSON matching execute schema structure',
  fn: async () => {
    if (skipNoClaude()) return;
    const k = await getApiKey();
    if (skipNoKey(k)) return;

    const token = getClaudeToken()!;

    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ah(k!) },
      body: JSON.stringify({
        model: 'rose-labs/rose-1-lite',
        claude_token: token,
        messages: sampleMessages,
        max_tokens: 1024,
        stream: true,
        stream_options: { include_usage: true },
        response_format: responseFormat,
      }),
    });

    if (res.status !== 200) {
      const body = await res.text();
      console.log(`SKIP: Non-200 response (${res.status}): ${body.slice(0, 200)}`);
      return;
    }

    const { chunks } = await readStream(res);

    // Accumulate content from all chunks
    let fullContent = '';
    for (const chunk of chunks) {
      const content = chunk.choices?.[0]?.delta?.content || '';
      fullContent += content;
    }

    assertEquals(fullContent.length > 0, true, 'Must have accumulated content');

    // Content must be valid JSON
    let parsed;
    try {
      parsed = JSON.parse(fullContent);
    } catch (e) {
      throw new Error(`Accumulated content is not valid JSON: ${(e as Error).message}\nContent: ${fullContent.slice(0, 500)}`);
    }

    // Must have response field (string)
    assertExists(parsed.response, 'Parsed JSON must have "response" field');
    assertEquals(typeof parsed.response, 'string', '"response" must be a string');

    // Must have tool_calls field (array)
    assertExists(parsed.tool_calls, 'Parsed JSON must have "tool_calls" field');
    assertEquals(Array.isArray(parsed.tool_calls), true, '"tool_calls" must be an array');

    // Each tool_call must have a "tool" field
    for (const tc of parsed.tool_calls) {
      assertExists(tc.tool, 'Each tool_call must have a "tool" field');
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: 'claudeAuth: stream ends with [DONE] and includes usage chunk',
  fn: async () => {
    if (skipNoClaude()) return;
    const k = await getApiKey();
    if (skipNoKey(k)) return;

    const token = getClaudeToken()!;

    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ah(k!) },
      body: JSON.stringify({
        model: 'rose-labs/rose-1-lite',
        claude_token: token,
        messages: sampleMessages,
        max_tokens: 1024,
        stream: true,
        stream_options: { include_usage: true },
        response_format: responseFormat,
      }),
    });

    if (res.status !== 200) {
      const body = await res.text();
      console.log(`SKIP: Non-200 response (${res.status}): ${body.slice(0, 200)}`);
      return;
    }

    // Read full stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let full = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        full += decoder.decode(value, { stream: true });
      }
    } catch {
      // Connection may drop mid-stream — use whatever we've read
    } finally {
      try { reader.cancel(); } catch { /* already closed */ }
    }

    // Must end with [DONE]
    assertEquals(full.includes('[DONE]'), true, 'Stream must contain [DONE] sentinel');

    // Must include a usage chunk (since stream_options.include_usage = true)
    let hasUsage = false;
    for (const line of full.split('\n')) {
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      const js = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
      try {
        const parsed = JSON.parse(js.trim());
        if (parsed.usage) {
          hasUsage = true;
          assertExists(parsed.usage.prompt_tokens, 'Usage must have prompt_tokens');
          assertExists(parsed.usage.completion_tokens, 'Usage must have completion_tokens');
        }
      } catch { /* partial */ }
    }
    assertEquals(hasUsage, true, 'Stream must include a usage chunk when include_usage is true');
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: 'claudeAuth: request without claude_token does NOT produce -claude suffix',
  fn: async () => {
    const k = await getApiKey();
    if (skipNoKey(k)) return;

    // Same payload but without claude_token — should route through OpenRouter/racing
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ah(k!) },
      body: JSON.stringify({
        model: 'rose-labs/rose-1-lite',
        messages: [{ role: 'user', content: 'Say hi' }],
        max_tokens: 10,
        stream: true,
      }),
    });

    assertNotEquals(res.status, 401, 'Auth must pass');
    assertNotEquals(res.status, 400, 'Validation must pass');

    if (res.status !== 200) {
      const body = await res.text();
      console.log(`SKIP: Upstream provider unavailable (${res.status}): ${body.slice(0, 200)}`);
      return;
    }

    const { chunks } = await readStream(res);
    const models = chunks.map((c) => c.actual_model).filter(Boolean);

    // Without claude_token, actual_model should NOT have -claude suffix
    for (const model of models) {
      assertEquals(
        model.includes('-claude'),
        false,
        `Without claude_token, actual_model "${model}" should NOT have -claude suffix`,
      );
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// --- Cleanup ---

Deno.test('claude-auth cleanup: delete test data', async () => {
  await cleanupTestData();
});
