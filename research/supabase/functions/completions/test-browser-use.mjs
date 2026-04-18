/**
 * Test rose-1-browser-use with browser-use provider (model_seed=0)
 *
 * Run: node test-browser-use.mjs
 */

const ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';

async function testBrowserUse() {
  console.log('🌐 Testing rose-1-browser-use with browser-use provider...\n');

  // Sample browser-use request
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
      scroll_position: { x: 0, y: 0 },
    },
    action_history: [],
    available_actions: ['click', 'type', 'scroll', 'goto', 'done'],
    model_seed: 0, // Force browser-use provider
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
        'x-api-key': ROSE_API_KEY,
      },
      body: JSON.stringify(request),
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

// Test with action history
async function testBrowserUseWithHistory() {
  console.log('\n\n🌐 Testing with action history...\n');

  const request = {
    model: 'rose-labs/rose-1-browser-use',
    task: 'Fill in the username field with "testuser" and then click submit',
    browser_state: {
      url: 'https://example.com/login',
      dom_tree: `[1] form "Login Form"
  [2] label "Username"
  [3] input[type=text] placeholder="Enter username"
  [4] label "Password"
  [5] input[type=password] placeholder="Enter password"
  [6] button "Submit"
  [7] a "Forgot password?"`,
      viewport: { width: 1280, height: 720 },
      scroll_position: { x: 0, y: 0 },
    },
    action_history: [
      {
        step: 1,
        thinking: 'I need to navigate to the login page first',
        action: 'goto',
        result: { success: true },
      },
    ],
    available_actions: ['click', 'type', 'scroll', 'goto', 'done'],
    model_seed: 0,
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
        'x-api-key': ROSE_API_KEY,
      },
      body: JSON.stringify(request),
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

    if (data.action) {
      console.log('\n✅ Unified action received:');
      console.log(`   Action: ${data.action.action}`);
      console.log(`   Index: ${data.action.index}`);
      console.log(`   Thinking: ${data.action.thinking}`);
      if (data.action.params?.text) {
        console.log(`   Text: ${data.action.params.text}`);
      }
    }
  } catch (error) {
    console.error('❌ Request failed:', error);
  }
}

// Run tests
testBrowserUse()
  .then(() => testBrowserUseWithHistory())
  .then(() => console.log('\n\n✅ All tests completed!'))
  .catch(console.error);
