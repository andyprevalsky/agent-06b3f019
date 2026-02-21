/**
 * Test script to compare SSE output between structured-output mode and
 * native-tool mode for the claudeAuth pathway.
 *
 * Usage:
 *   node test-claude-auth-streaming.mjs baseline    # model_seed=3 (Anthropic structured output, no claudeAuth)
 *   node test-claude-auth-streaming.mjs claude       # claude_token (claudeAuth native tools path)
 */

import { execSync } from 'child_process';

// Use local dev server by default, pass --prod to use production
const USE_LOCAL = !process.argv.includes('--prod');
const SUPABASE_URL = USE_LOCAL
  ? 'http://127.0.0.1:54321/functions/v1/completions'
  : 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU';
const API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';

function getClaudeTokenFromKeychain() {
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      stdio: 'pipe', encoding: 'utf8'
    }).trim();
    const parsed = JSON.parse(raw);
    return parsed.claudeAiOauth?.accessToken;
  } catch (e) {
    console.error('Failed to read Claude token from keychain:', e.message);
    return null;
  }
}

// Full execute-phase schema with 11 tools (exceeds Anthropic's 8 anyOf branch limit for structured output)
const EXECUTE_SCHEMA = {
  type: "object",
  properties: {
    response: {
      type: "string",
      description: "Thinking/reasoning about what to do next."
    },
    tool_calls: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            properties: {
              tool: { type: "string", const: "web_search" },
              query: { type: "string", description: "Search query" }
            },
            required: ["tool", "query"],
            additionalProperties: false
          },
          {
            type: "object",
            properties: {
              tool: { type: "string", const: "web_fetch" },
              url: { type: "string", description: "URL to fetch" },
              prompt: { type: "string", description: "What to extract" }
            },
            required: ["tool", "url", "prompt"],
            additionalProperties: false
          },
          {
            type: "object",
            properties: {
              tool: { type: "string", const: "attempt_completion" },
              result: { type: "string", description: "Final result" }
            },
            required: ["tool", "result"],
            additionalProperties: false
          },
          {
            type: "object",
            properties: {
              tool: { type: "string", const: "send_message_to_user_execute_phase" },
              message: { type: "string", description: "Message to user" },
              is_question: { type: "boolean", description: "Whether this requires a response" }
            },
            required: ["tool", "message", "is_question"],
            additionalProperties: false
          },
          {
            type: "object",
            properties: {
              tool: { type: "string", const: "wait_seconds" },
              seconds: { type: "number", description: "Seconds to wait" },
              reason: { type: "string", description: "Why waiting" }
            },
            required: ["tool", "seconds", "reason"],
            additionalProperties: false
          },
          {
            type: "object",
            properties: {
              tool: { type: "string", const: "spawn_browser_agent" },
              url: { type: "string", description: "URL to navigate to" },
              task: { type: "string", description: "Task for browser agent" }
            },
            required: ["tool", "url", "task"],
            additionalProperties: false
          },
          {
            type: "object",
            properties: {
              tool: { type: "string", const: "spawn_claude_code_agent" },
              task: { type: "string", description: "Coding task" },
              repo_url: { type: "string", description: "Repository URL" }
            },
            required: ["tool", "task", "repo_url"],
            additionalProperties: false
          },
          {
            type: "object",
            properties: {
              tool: { type: "string", const: "spawn_sub_agent" },
              goal: { type: "string", description: "Sub-agent goal" }
            },
            required: ["tool", "goal"],
            additionalProperties: false
          },
          {
            type: "object",
            properties: {
              tool: { type: "string", const: "people_search" },
              query: { type: "string", description: "Search query for people" }
            },
            required: ["tool", "query"],
            additionalProperties: false
          },
          {
            type: "object",
            properties: {
              tool: { type: "string", const: "call_phone_number" },
              phone_number: { type: "string", description: "Phone number" },
              prompt: { type: "string", description: "Call prompt" }
            },
            required: ["tool", "phone_number", "prompt"],
            additionalProperties: false
          },
          {
            type: "object",
            properties: {
              tool: { type: "string", const: "send_sms_as_user" },
              phone_number: { type: "string", description: "Phone number" },
              message: { type: "string", description: "SMS message" }
            },
            required: ["tool", "phone_number", "message"],
            additionalProperties: false
          }
        ]
      }
    }
  },
  required: ["response", "tool_calls"],
  additionalProperties: false
};

async function streamRequest(requestBody, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`=== ${label} ===`);
  console.log(`${'='.repeat(60)}\n`);

  const response = await fetch(SUPABASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ANON_KEY}`,
      'x-api-key': API_KEY,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`HTTP ${response.status}: ${errorText}`);
    return null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chunkIndex = 0;
  let fullContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') {
        console.log(`CHUNK[${chunkIndex}] [DONE]`);
        continue;
      }

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content || '';
        const usage = parsed.usage;
        const actualModel = parsed.actual_model;

        if (content) {
          fullContent += content;
          console.log(`CHUNK[${chunkIndex}] content=${JSON.stringify(content)} actual_model=${actualModel || ''}`);
        } else if (usage) {
          console.log(`CHUNK[${chunkIndex}] usage=${JSON.stringify(usage)} actual_model=${actualModel || ''}`);
        } else {
          console.log(`CHUNK[${chunkIndex}] (no content) raw=${JSON.stringify(parsed).slice(0, 200)}`);
        }
        chunkIndex++;
      } catch (e) {
        console.log(`CHUNK[${chunkIndex}] PARSE_ERROR: ${data.slice(0, 200)}`);
        chunkIndex++;
      }
    }
  }

  console.log('\n--- FULL ACCUMULATED CONTENT ---');
  console.log(fullContent);
  console.log('\n--- PARSED JSON ---');
  try {
    const parsed = JSON.parse(fullContent);
    console.log(JSON.stringify(parsed, null, 2));
    return parsed;
  } catch (e) {
    console.log(`Failed to parse: ${e.message}`);
    console.log('Raw (first 500):', fullContent.slice(0, 500));
    return null;
  }
}

async function main() {
  const mode = process.argv[2] || 'baseline';

  const messages = [
    {
      role: "system",
      content: "You are a helpful agent. Respond with a brief thought in the response field, then call web_search to search for 'weather in San Francisco today'."
    },
    {
      role: "user",
      content: "What's the weather like in San Francisco right now?"
    }
  ];

  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "AgentAction",
      schema: EXECUTE_SCHEMA,
      strict: true
    }
  };

  if (mode === 'baseline') {
    // Structured output via model_seed=3 (anthropic/claude-haiku-4.5)
    await streamRequest({
      model: "rose-labs/rose-1-lite",
      model_seed: 3,
      messages,
      max_tokens: 1024,
      stream: true,
      stream_options: { include_usage: true },
      response_format: responseFormat,
    }, 'BASELINE: Anthropic structured output (model_seed=3)');

  } else if (mode === 'claude') {
    // claudeAuth path with real token from keychain
    const token = getClaudeTokenFromKeychain();
    if (!token) {
      console.error('No Claude token available');
      process.exit(1);
    }
    console.log(`Claude token: ${token.slice(0, 20)}...${token.slice(-10)}`);

    await streamRequest({
      model: "rose-labs/rose-1-lite",
      claude_token: token,
      messages,
      max_tokens: 1024,
      stream: true,
      stream_options: { include_usage: true },
      response_format: responseFormat,
    }, 'CLAUDE AUTH: Native tools via claude_token');

  } else if (mode === 'claude-json-text') {
    // Test case: prompt that tricks model into outputting JSON as text
    const token = getClaudeTokenFromKeychain();
    if (!token) {
      console.error('No Claude token available');
      process.exit(1);
    }
    console.log(`Claude token: ${token.slice(0, 20)}...${token.slice(-10)}`);

    const jsonTextMessages = [
      {
        role: "system",
        content: `You are a helpful agent. You MUST respond in this exact JSON format:
{"reasoning": "<your thinking>", "response": "<brief response>", "tool_calls": [{"name": "<tool_name>", "arguments": {"param": "value"}}]}

Available tools: web_search (query), web_fetch (url, prompt), attempt_completion (result)

Respond with a brief thought and call web_search for 'weather in San Francisco today'.`
      },
      {
        role: "user",
        content: "What's the weather like in San Francisco right now?"
      }
    ];

    await streamRequest({
      model: "rose-labs/rose-1-lite",
      claude_token: token,
      messages: jsonTextMessages,
      max_tokens: 1024,
      stream: true,
      stream_options: { include_usage: true },
      response_format: responseFormat,
    }, 'CLAUDE AUTH (JSON text fallback): Model outputs JSON as text');

  } else if (mode === 'claude-think') {
    // Test with a prompt that encourages thinking + tool use
    const token = getClaudeTokenFromKeychain();
    if (!token) {
      console.error('No Claude token available');
      process.exit(1);
    }
    console.log(`Claude token: ${token.slice(0, 20)}...${token.slice(-10)}`);

    const thinkMessages = [
      {
        role: "system",
        content: "You are a helpful agent. Always explain your reasoning in the text response before calling tools. Think step by step about what you need to do."
      },
      {
        role: "user",
        content: "I need to find the best Italian restaurant in San Francisco and also check what the weather will be like tonight for dinner. Can you help?"
      }
    ];

    await streamRequest({
      model: "rose-labs/rose-1-lite",
      claude_token: token,
      messages: thinkMessages,
      max_tokens: 1024,
      stream: true,
      stream_options: { include_usage: true },
      response_format: responseFormat,
    }, 'CLAUDE AUTH: Thinking + multiple tool calls');

  } else {
    console.error(`Unknown mode: ${mode}. Use 'baseline', 'claude', 'claude-json-text', or 'claude-think'`);
    process.exit(1);
  }
}

main().catch(console.error);
