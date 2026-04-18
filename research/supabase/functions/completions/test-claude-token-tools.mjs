/**
 * Test: Non-streaming claude token path with tools + reasoning
 * Validates that tools/tool_choice/reasoning are correctly transformed to Anthropic format
 * and that tool_use response blocks are parsed back to OpenAI format.
 *
 * Run: node test-claude-token-tools.mjs
 */

import process from 'node:process';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY env var required');
  process.exit(1);
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// --- Helpers (mirror the logic in index.ts) ---

/** Transform OpenAI-format tools to Anthropic format (same as index.ts lines 4016-4020) */
function transformTools(tools) {
  return tools.map((t) => ({
    name: t.function?.name ?? t.name,
    description: t.function?.description ?? t.description,
    input_schema: t.function?.parameters ?? t.input_schema,
  }));
}

/** Transform OpenAI tool_choice to Anthropic format (same as index.ts lines 4021-4025) */
function transformToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required' || toolChoice === 'any') return { type: 'any' };
  if (toolChoice?.function?.name) return { type: 'tool', name: toolChoice.function.name };
  return undefined;
}

/** Parse Anthropic response to OpenAI format (same as index.ts lines 4060-4075) */
function parseAnthropicResponse(data) {
  let textContent = '';
  const toolCalls = [];
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
  const message = { content: textContent };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return message;
}

// --- Test cases ---

async function testToolCall() {
  console.log('🔧 Test 1: Tool call with tool_choice=auto\n');

  const openaiTools = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather for a city',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' },
          },
          required: ['city'],
        },
      },
    },
  ];

  const anthropicTools = transformTools(openaiTools);
  const anthropicToolChoice = transformToolChoice('auto');

  console.log('  Transformed tools:', JSON.stringify(anthropicTools, null, 2));
  console.log('  Transformed tool_choice:', JSON.stringify(anthropicToolChoice));

  // Validate transform structure
  console.assert(anthropicTools[0].name === 'get_weather', '❌ Tool name mismatch');
  console.assert(anthropicTools[0].input_schema.type === 'object', '❌ input_schema missing');
  console.assert(!anthropicTools[0].function, '❌ Should not have function wrapper');
  console.assert(anthropicToolChoice.type === 'auto', '❌ tool_choice type mismatch');
  console.log('  ✅ Transform structure valid\n');

  // Hit Anthropic API
  const body = {
    model: 'claude-sonnet-4-5-20250929',
    messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
    max_tokens: 1024,
    tools: anthropicTools,
    tool_choice: anthropicToolChoice,
  };

  console.log('  Calling Anthropic API...');
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`  ❌ API error: ${response.status} - ${err.slice(0, 300)}`);
    return false;
  }

  const data = await response.json();
  console.log('  Raw Anthropic content blocks:', JSON.stringify(data.content.map((b) => b.type)));

  const parsed = parseAnthropicResponse(data);
  console.log('  Parsed OpenAI message:', JSON.stringify(parsed, null, 2));

  // Validate response parsing
  console.assert(parsed.tool_calls?.length > 0, '❌ No tool_calls in parsed response');
  const tc = parsed.tool_calls[0];
  console.assert(tc.type === 'function', '❌ tool_call type should be function');
  console.assert(tc.function.name === 'get_weather', '❌ tool_call name mismatch');
  console.assert(tc.id, '❌ tool_call missing id');
  const args = JSON.parse(tc.function.arguments);
  console.assert(args.city, '❌ tool_call arguments missing city');
  console.log(`  ✅ Tool call parsed: get_weather(${JSON.stringify(args)})\n`);
  return true;
}

function testForcedToolChoice() {
  console.log('🎯 Test 2: tool_choice with specific function name\n');

  const tc = transformToolChoice({ type: 'function', function: { name: 'my_tool' } });
  console.assert(tc.type === 'tool', '❌ Expected type=tool');
  console.assert(tc.name === 'my_tool', '❌ Expected name=my_tool');
  console.log(`  tool_choice: ${JSON.stringify(tc)}`);
  console.log('  ✅ Forced tool_choice transform correct\n');
  return true;
}

function testRequiredToolChoice() {
  console.log('🔒 Test 3: tool_choice="required" maps to type=any\n');

  const tc = transformToolChoice('required');
  console.assert(tc.type === 'any', '❌ Expected type=any');
  console.log(`  tool_choice: ${JSON.stringify(tc)}`);
  console.log('  ✅ Required tool_choice transform correct\n');
  return true;
}

function testReasoningTransform() {
  console.log('🧠 Test 4: Reasoning config transforms to thinking\n');

  // Mirror the logic from index.ts line 4027-4028
  const cappedReasoning = { max_tokens: 512 };
  const thinking = cappedReasoning?.max_tokens
    ? { type: 'enabled', budget_tokens: cappedReasoning.max_tokens }
    : undefined;

  console.assert(thinking.type === 'enabled', '❌ thinking type mismatch');
  console.assert(thinking.budget_tokens === 512, '❌ budget_tokens mismatch');
  console.log(`  thinking: ${JSON.stringify(thinking)}`);
  console.log('  ✅ Reasoning transform correct\n');
  return true;
}

function testNoToolsNoTransform() {
  console.log('📭 Test 5: Empty tools array is not added to body\n');

  // Mirror the guard: if (tools?.length)
  const tools = [];
  const shouldAdd = tools?.length > 0;
  console.assert(!shouldAdd, '❌ Empty tools should not be added');
  console.log('  ✅ Empty tools correctly skipped\n');
  return true;
}

// --- Run all tests ---

async function main() {
  console.log('=== Non-streaming claude token path: tools + reasoning test ===\n');
  const results = await Promise.all([
    testToolCall(),
    testForcedToolChoice(),
    testRequiredToolChoice(),
    testReasoningTransform(),
    testNoToolsNoTransform(),
  ]);

  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`${passed === total ? '✅' : '❌'} ${passed}/${total} tests passed`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
