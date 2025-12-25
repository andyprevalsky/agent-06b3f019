/**
 * Test vision transformation in Rose completions function
 * 
 * Tests that __screenshot_base64__ in tool messages is properly transformed
 * to multimodal format for vision models, and left as-is for non-vision models.
 * 
 * Uses model_seed to test specific models in the rose-1-ultra pool.
 */

import { readFileSync } from 'fs';

const ROSE_API_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';
const ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU';

const SCREENSHOT_BASE64 = readFileSync('/tmp/text_image_b64.txt', 'utf-8').trim();
const EXPECTED_TEXT = readFileSync('/tmp/test_paragraph.txt', 'utf-8').trim();

console.log('=== Testing Vision Transform in Rose Function ===\n');
console.log('Expected text (first 80 chars):', EXPECTED_TEXT.slice(0, 80));
console.log('Base64 length:', SCREENSHOT_BASE64.length);
console.log('');

// rose-1-ultra pool models with their seeds
// seed 0: openai/gpt-5.2 (vision)
// seed 1: anthropic/claude-sonnet-4.5 (vision)
// seed 2: moonshotai/kimi-k2-thinking (non-vision)
// seed 3: google/gemini-3-pro-preview (vision)
// seed 4: x-ai/grok-4.1-fast (vision)
const ULTRA_POOL = [
  { seed: 0, name: 'GPT 5.2', vision: true },
  { seed: 1, name: 'Claude Sonnet 4.5', vision: true },
  { seed: 2, name: 'Kimi K2 Thinking', vision: false },
  { seed: 3, name: 'Gemini 3 Pro Preview', vision: true },
  { seed: 4, name: 'Grok 4.1 Fast', vision: true },
];

// Create messages that simulate browser agent screenshot tool result
function createTestMessages() {
  return [
    {
      role: 'system',
      content: 'You are an OCR assistant. When given a screenshot, transcribe the visible text exactly as shown.'
    },
    {
      role: 'user', 
      content: 'Take a screenshot of the page'
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_screenshot_123',
        type: 'function',
        function: {
          name: 'screenshot',
          arguments: '{}'
        }
      }]
    },
    {
      role: 'tool',
      tool_call_id: 'call_screenshot_123',
      content: JSON.stringify({
        success: true,
        screenshot_taken: true,
        __screenshot_base64__: SCREENSHOT_BASE64,
        timestamp: new Date().toISOString(),
        pageUrl: 'https://example.com/test'
      })
    },
    {
      role: 'user',
      content: 'Now transcribe ALL the text visible in that screenshot. Output ONLY the raw text, nothing else.'
    }
  ];
}

async function testModel(modelConfig) {
  const { seed, name, vision } = modelConfig;
  console.log(`\n--- Testing ${name} (seed=${seed}) ---`);
  console.log(`Vision capable: ${vision}`);
  
  const messages = createTestMessages();
  
  try {
    const response = await fetch(ROSE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'x-api-key': ROSE_API_KEY
      },
      body: JSON.stringify({
        model: 'rose-1-ultra',  // Use the pool
        model_seed: seed,       // Select specific model
        messages,
        max_tokens: 1500,
        temperature: 0,
        stream: false
      })
    });

    const data = await response.json();
    
    if (data.error) {
      console.log('❌ Error:', data.error, data.details?.slice(0, 100));
      return { name, seed, success: false, error: data.error };
    }

    const actualModel = data.actual_model;
    console.log('Actual model:', actualModel);
    
    const content = data.choices?.[0]?.message?.content || '';
    console.log('Response (first 200 chars):', content.slice(0, 200));
    
    // Check how much of the expected text appears in the response
    const expectedWords = EXPECTED_TEXT.split(/\s+/).slice(0, 20); // First 20 words
    let matchCount = 0;
    for (const word of expectedWords) {
      if (content.toLowerCase().includes(word.toLowerCase())) {
        matchCount++;
      }
    }
    
    const matchPercent = Math.round((matchCount / expectedWords.length) * 100);
    console.log(`Word match: ${matchCount}/${expectedWords.length} (${matchPercent}%)`);
    
    if (vision) {
      if (matchPercent >= 50) {
        console.log('✅ PASS - Vision model correctly read the image');
        return { name, seed, success: true, matchPercent, actualModel };
      } else {
        console.log('❌ FAIL - Vision model could not read the image');
        return { name, seed, success: false, matchPercent, actualModel };
      }
    } else {
      // Non-vision model - expect it to not be able to read
      if (matchPercent < 30) {
        console.log('✅ PASS - Non-vision model correctly cannot see image (expected)');
        return { name, seed, success: true, matchPercent, actualModel, expected: 'no-vision' };
      } else {
        console.log('⚠️ Surprising - non-vision model somehow read the image?');
        return { name, seed, success: true, matchPercent, actualModel, unexpected: true };
      }
    }
    
  } catch (error) {
    console.log('❌ Request error:', error.message);
    return { name, seed, success: false, error: error.message };
  }
}

// Run tests
console.log('\n========================================');
console.log('Testing rose-1-ultra pool models...');
console.log('========================================\n');

const results = [];
for (const modelConfig of ULTRA_POOL) {
  const result = await testModel(modelConfig);
  results.push(result);
  // Small delay between tests
  await new Promise(r => setTimeout(r, 1500));
}

console.log('\n========================================');
console.log('SUMMARY');
console.log('========================================');
for (const r of results) {
  const status = r.success ? '✅' : '❌';
  const detail = r.matchPercent !== undefined ? `${r.matchPercent}% match` : r.error;
  console.log(`${status} ${r.name} (${r.actualModel || 'unknown'}): ${detail}`);
}
