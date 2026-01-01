/**
 * Test rose-1-browser-use random rotation (no model_seed)
 * 
 * Run: node test-rotation.mjs
 */

const ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';

async function testRotation() {
  console.log('🎲 Testing rose-1-browser-use random rotation (no model_seed)...\n');
  
  // Request WITHOUT model_seed - should randomly pick provider
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
  [7] h1 "Welcome to Example.com"`,
      viewport: { width: 1280, height: 720 },
      scroll_position: { x: 0, y: 0 }
    },
    action_history: [],
    available_actions: ['click', 'type', 'scroll', 'goto', 'done']
    // NO model_seed - random rotation
  };
  
  console.log('📤 Request (no model_seed - random selection):');
  console.log(JSON.stringify(request, null, 2));
  console.log('\n');
  
  // Run 3 times to see rotation
  for (let i = 1; i <= 3; i++) {
    console.log(`\n--- Run ${i}/3 ---`);
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
        continue;
      }
      
      const data = await response.json();
      
      console.log(`✅ Provider: ${data.actual_model} (index: ${data.provider_index})`);
      console.log(`   Action: ${data.action.action}, Index: ${data.action.index}`);
      console.log(`   Time: ${elapsed}ms (TTFT: ${data.ttft_ms}ms)`);
      
    } catch (error) {
      console.error('❌ Request failed:', error);
    }
    
    // Brief pause between requests
    await new Promise(r => setTimeout(r, 500));
  }
}

// Run test
testRotation()
  .then(() => console.log('\n\n✅ Test completed!'))
  .catch(console.error);



