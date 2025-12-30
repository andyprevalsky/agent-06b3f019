/**
 * Test rose-1-browser-use with Yutori n1 provider (model_seed=1)
 * 
 * Run: node test-yutori.mjs
 */

const ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';

// Use the same URL as the working direct test
const SCREENSHOT_URL = 'https://upload.wikimedia.org/wikipedia/commons/5/53/Google_homepage_%28as_of_January_2024%29.jpg';

async function testYutori() {
  console.log('🎯 Testing rose-1-browser-use with Yutori n1 provider...\n');
  
  // Sample browser-use request with screenshot URL (required for Yutori)
  const request = {
    model: 'rose-labs/rose-1-browser-use',
    task: 'Click on the Google Search button',
    browser_state: {
      url: 'https://google.com',
      dom_tree: `[1] img "Google Logo"
[2] input "Search box"
[3] button "Google Search"
[4] button "I'm Feeling Lucky"`,
      screenshot: SCREENSHOT_URL,  // Use URL directly
      viewport: { width: 1280, height: 720 },
      scroll_position: { x: 0, y: 0 }
    },
    action_history: [],
    available_actions: ['click', 'type', 'scroll', 'goto', 'done'],
    model_seed: 1  // Force Yutori provider
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
      console.log(`   Coordinates (viewport): ${JSON.stringify(data.action.coordinates)}`);
      console.log(`   Thinking: ${data.action.thinking}`);
      if (data.action.params?.center_coordinates || data.action.params?.normalized_coordinates) {
        console.log(`   Normalized coords (1000x1000): ${JSON.stringify(data.action.params.center_coordinates || data.action.params.normalized_coordinates)}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Request failed:', error);
  }
}

// Run test
testYutori()
  .then(() => console.log('\n\n✅ Test completed!'))
  .catch(console.error);

