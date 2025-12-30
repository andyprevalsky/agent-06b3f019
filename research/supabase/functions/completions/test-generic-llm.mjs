/**
 * Test rose-1-browser-use with Generic LLM provider (model_seed=3, GPT-5.2)
 * 
 * Run: node test-generic-llm.mjs
 */

const ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';

async function testGenericLLM() {
  console.log('🎯 Testing rose-1-browser-use with Generic LLM (GPT-5.2)...\n');
  
  // Sample browser-use request (no screenshot needed for DOM-based models)
  const request = {
    model: 'rose-labs/rose-1-browser-use',
    task: 'Click the "Sign In" button',
    browser_state: {
      url: 'https://example.com',
      dom_tree: `[1] header "Navigation"
  [2] button "Home"
  [3] button "About"
  [4] button "Sign In"
  [5] button "Sign Up"
[6] main "Content"
  [7] h1 "Welcome to Example.com"
  [8] p "This is a test page"`,
      viewport: { width: 1280, height: 720 },
      scroll_position: { x: 0, y: 0 }
    },
    action_history: [],
    available_actions: ['click', 'type', 'scroll', 'goto', 'done'],
    model_seed: 3  // Force Generic LLM (GPT-5.2) provider
  };
  
  console.log('📤 Request:');
  console.log(JSON.stringify(request, null, 2));
  console.log('\n');
  
  const startTime = Date.now();
  
  try {
    const response = await fetch(SUPABASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ROSE_API_KEY
      },
      body: JSON.stringify(request)
    });
    
    const elapsed = Date.now() - startTime;
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`❌ Error: ${response.status}`);
      console.log(errorText);
      return;
    }
    
    const data = await response.json();
    
    console.log('📥 Response:');
    console.log(JSON.stringify(data, null, 2));
    console.log(`\n⏱️ Total time: ${elapsed}ms`);
    console.log(`⏱️ TTFT (from provider): ${data.ttft_ms}ms`);
    
    // Validate response structure
    if (data.action) {
      console.log('\n✅ Unified action received:');
      console.log(`   Action: ${data.action.action}`);
      console.log(`   Index: ${data.action.index}`);
      console.log(`   Thinking: ${data.action.thinking}`);
    }
    
  } catch (error) {
    console.error('❌ Request failed:', error);
  }
}

// Run test
testGenericLLM()
  .then(() => console.log('\n\n✅ Test completed!'))
  .catch(console.error);

