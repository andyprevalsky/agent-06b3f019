/**
 * Rose Model Pool Test
 *
 * Tests each model in the rose-1-lite pool using model_seed parameter
 * with realistic agent conversation data formatted properly.
 *
 * Run with: node tests/test-rose-model-pool.mjs
 */

import process from 'node:process';
const ROSE_API_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';
const ROSE_API_KEY = process.env.ROSE_API_KEY || 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU';

// Expected models in rose-1-lite pool (after typo fix)
const EXPECTED_MODELS = [
  'openai/gpt-oss-120b',
  'qwen/qwen3-235b-a22b-thinking-2507',
  'moonshotai/kimi-k2-0905',
  'meta-llama/llama-4-maverick',
  'deepseek/deepseek-v3.2-exp',
  'z-ai/glm-4.6',
  'openai/gpt-5.1',
  'mistralai/mistral-medium-3.1',
  'google/gemini-2.5-flash',
  'nousresearch/hermes-4-405b',
  'minimax/minimax-m2',
  'x-ai/grok-4-fast',
];

// Realistic JSON schema (simplified AgentAction - similar to what agents use)
const AGENT_ACTION_SCHEMA = {
  'type': 'object',
  'title': 'AgentAction',
  'properties': {
    'reasoning': {
      'type': 'string',
      'description': 'Your internal reasoning and thought process',
    },
    'response': {
      'type': 'string',
      'description': 'Your response message',
    },
    'tool_calls': {
      'type': 'array',
      'description': 'Tool calls to execute',
      'items': {
        'type': 'object',
        'properties': {
          'tool': { 'type': 'string', 'description': 'Tool name' },
          'query': { 'type': 'string', 'description': 'Search query' },
        },
        'required': ['tool'],
      },
    },
  },
  'required': ['reasoning', 'response'],
};

// Realistic system prompt (abbreviated from actual agent)
const SYSTEM_PROMPT = `IDENTITY:
- You are an AI assistant helping users accomplish tasks.
- Each turn: think, respond, optionally use tools.
- A verifier scores progress (0-100%) after each response.

RESPONSE FIELDS:
- "reasoning": internal scratchpad (logged, not shown to user)
- "response": progress log for verifier and your future self
- "tool_calls": optional array of tool invocations

TOOLS:
- web_search: Search the web for information
- send_message_to_user: Ask the user a question or share a plan update
- monitor: Set up ongoing monitoring for a topic

Respond with valid JSON matching the schema.`;

// Build realistic conversation with proper OpenAI format
// This mirrors what convert_context_to_messages produces
const TEST_MESSAGES = [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: 'Mitigate the impending climate crisis' },
  { role: 'system', content: 'No similar goals found: No blueprints matched this goal.' },
  {
    role: 'assistant',
    content:
      'To begin addressing the climate crisis mitigation goal, I need to gather more information.',
    tool_calls: [{
      id: 'tc_001',
      type: 'function',
      function: {
        name: 'send_message_to_user',
        arguments: JSON.stringify({
          question: 'What specific aspects of climate change are you most concerned about?',
        }),
      },
    }],
  },
  {
    role: 'tool',
    tool_call_id: 'tc_001',
    name: 'send_message_to_user',
    content: '🔔 Messaging the user: Question sent to user',
  },
  { role: 'user', content: 'all of them do everything u can' },
  {
    role: 'assistant',
    content:
      '⚖️ Goal progress is 0%: The agent has started by asking clarifying questions but has not taken concrete action.',
  },
  {
    role: 'assistant',
    content: "I'll search for effective climate mitigation strategies.",
    tool_calls: [{
      id: 'tc_002',
      type: 'function',
      function: {
        name: 'web_search',
        arguments: JSON.stringify({ query: 'systemic climate solutions policy technology' }),
      },
    }],
  },
  {
    role: 'tool',
    tool_call_id: 'tc_002',
    name: 'web_search',
    content:
      'Web search completed: Found information about carbon pricing, renewable energy mandates, and technological solutions like carbon capture. Key strategies include: 1) Carbon taxes and cap-and-trade systems, 2) Renewable portfolio standards, 3) Building efficiency codes, 4) Electric vehicle mandates.',
  },
  {
    role: 'assistant',
    content:
      '⚖️ Goal progress is 0%: The agent conducted web searches but no concrete interventions or policy changes have been implemented.',
  },
  { role: 'user', content: 'dont make me change anything personal' },
  {
    role: 'assistant',
    content:
      "Since you prefer systemic solutions, I'll set up monitoring for climate policy developments.",
    tool_calls: [{
      id: 'tc_003',
      type: 'function',
      function: {
        name: 'monitor',
        arguments: JSON.stringify({
          query: 'climate policy breakthroughs carbon pricing legislation',
          cadence: 'daily',
        }),
      },
    }],
  },
  {
    role: 'tool',
    tool_call_id: 'tc_003',
    name: 'monitor',
    content: 'Monitor created: monitor_abc123 tracking climate policy developments daily.',
  },
  {
    role: 'assistant',
    content: '⚖️ Goal progress is 0%: Monitor created but no verifiable climate impact achieved.',
  },
  { role: 'user', content: 'Based on everything so far, what should I do next?' },
];

async function testModelSeed(seed) {
  const startTime = Date.now();

  const requestBody = {
    model: 'rose-labs/rose-1-lite',
    messages: TEST_MESSAGES,
    temperature: 0.7,
    max_tokens: 1000,
    model_seed: seed,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'AgentAction',
        schema: AGENT_ACTION_SCHEMA,
        strict: true,
      },
    },
  };

  try {
    const response = await fetch(ROSE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'x-api-key': ROSE_API_KEY,
      },
      body: JSON.stringify(requestBody),
    });

    const latency = Date.now() - startTime;
    const data = await response.json();

    if (!response.ok) {
      return {
        model_seed: seed,
        model_name: EXPECTED_MODELS[seed] || `unknown (seed=${seed})`,
        success: false,
        status_code: response.status,
        error: data.error || data.details || JSON.stringify(data).slice(0, 500),
        latency_ms: latency,
      };
    }

    const content = data.choices?.[0]?.message?.content;
    let parsedContent;
    try {
      parsedContent = JSON.parse(content);
      // Verify required fields
      if (!parsedContent.reasoning || !parsedContent.response) {
        throw new Error('Missing required fields');
      }
    } catch (e) {
      return {
        model_seed: seed,
        model_name: EXPECTED_MODELS[seed] || `unknown (seed=${seed})`,
        success: false,
        status_code: response.status,
        error: `JSON parse/validation error: ${e.message}. Content: ${content?.slice(0, 200)}`,
        latency_ms: latency,
      };
    }

    return {
      model_seed: seed,
      model_name: EXPECTED_MODELS[seed] || `unknown (seed=${seed})`,
      success: true,
      status_code: response.status,
      latency_ms: latency,
      reasoning_preview: parsedContent.reasoning?.slice(0, 80) + '...',
    };
  } catch (error) {
    return {
      model_seed: seed,
      model_name: EXPECTED_MODELS[seed] || `unknown (seed=${seed})`,
      success: false,
      status_code: 0,
      error: error.message || String(error),
      latency_ms: Date.now() - startTime,
    };
  }
}

async function main() {
  console.log('═'.repeat(80));
  console.log('🧪 ROSE MODEL POOL TEST - rose-1-lite');
  console.log('═'.repeat(80));
  console.log('');
  console.log(`Testing ${EXPECTED_MODELS.length} models with realistic agent conversation...\n`);

  // Test out of range first
  console.log('Testing model_seed out of range...');
  const outOfRangeResult = await testModelSeed(999);
  if (outOfRangeResult.error?.includes('out of range')) {
    console.log('✅ Out of range error works correctly\n');
  } else {
    console.log(`⚠️ Unexpected response: ${outOfRangeResult.error}\n`);
  }

  const results = [];

  // Test each model
  for (let seed = 0; seed < EXPECTED_MODELS.length; seed++) {
    const expectedModel = EXPECTED_MODELS[seed];
    console.log(`[${seed}/${EXPECTED_MODELS.length - 1}] Testing: ${expectedModel}`);

    const result = await testModelSeed(seed);
    results.push(result);

    if (result.success) {
      console.log(`    ✅ SUCCESS (${result.latency_ms}ms)`);
      if (result.reasoning_preview) {
        console.log(`    📝 ${result.reasoning_preview}`);
      }
    } else {
      console.log(`    ❌ FAILED (status ${result.status_code})`);
      console.log(`    Error: ${result.error?.slice(0, 150)}`);
    }
    console.log('');

    await new Promise((r) => setTimeout(r, 1000));
  }

  // Summary
  console.log('═'.repeat(80));
  console.log('📊 SUMMARY');
  console.log('═'.repeat(80));
  console.log('');

  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);

  console.log(`✅ Passed: ${successes.length}/${results.length}`);
  console.log(`❌ Failed: ${failures.length}/${results.length}`);
  console.log('');

  if (failures.length > 0) {
    console.log('FAILED MODELS:');
    console.log('─'.repeat(80));
    for (const f of failures) {
      console.log(`\n[${f.model_seed}] ${f.model_name}`);
      console.log(`    Status: ${f.status_code}`);
      console.log(`    Error: ${f.error}`);
    }
  }

  if (successes.length > 0) {
    console.log('\n\nSUCCESSFUL MODELS:');
    console.log('─'.repeat(80));
    for (const s of successes) {
      console.log(`[${s.model_seed}] ${s.model_name} (${s.latency_ms}ms)`);
    }
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main();
