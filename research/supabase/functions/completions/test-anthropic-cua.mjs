/**
 * Test rose-1-browser-use with Anthropic CUA provider (model_seed=2)
 * 
 * Run: node test-anthropic-cua.mjs
 */

const ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';

// Fetch a sample screenshot and convert to base64 (CUA requires base64)
async function getScreenshotBase64() {
  console.log('📸 Fetching sample screenshot...');
  const imageUrl = 'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png';
  
  const response = await fetch(imageUrl);
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  console.log(`📸 Screenshot fetched: ${base64.length} chars base64`);
  return base64;
}

async function testAnthropicCUA() {
  console.log('🎯 Testing rose-1-browser-use with Anthropic CUA provider...\n');
  
  // Get screenshot as base64 (required for CUA)
  const screenshot = await getScreenshotBase64();
  
  // Sample browser-use request with base64 screenshot
  const request = {
    model: 'rose-labs/rose-1-browser-use',
    task: 'Click on the Google logo',
    browser_state: {
      url: 'https://google.com',
      dom_tree: `[1] img "Google Logo"
[2] input "Search box"
[3] button "Google Search"`,
      screenshot: screenshot,  // base64 required for CUA
      viewport: { width: 1280, height: 720 },
      scroll_position: { x: 0, y: 0 }
    },
    action_history: [],
    available_actions: ['click', 'type', 'scroll', 'goto', 'done'],
    model_seed: 2  // Force Anthropic CUA provider
  };
  
  console.log('📤 Request (screenshot truncated):');
  const displayRequest = { ...request };
  displayRequest.browser_state = { ...request.browser_state };
  displayRequest.browser_state.screenshot = `<${screenshot.length} chars base64>`;
  console.log(JSON.stringify(displayRequest, null, 2));
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
      console.log(`   Coordinates: ${JSON.stringify(data.action.coordinates)}`);
      console.log(`   Thinking: ${data.action.thinking}`);
      if (data.action.params) {
        console.log(`   Params: ${JSON.stringify(data.action.params)}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Request failed:', error);
  }
}

// Run test
testAnthropicCUA()
  .then(() => console.log('\n\n✅ Test completed!'))
  .catch(console.error);



