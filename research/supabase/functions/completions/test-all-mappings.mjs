// Comprehensive test for all action name and param mappings
const SUPABASE_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU';
const ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';

const tests = [
  {
    name: 'input_text',
    task: 'Type "test" into the search box at index 5',
    expectedAction: 'input_text',
    expectedParams: { text: true, index: true }
  },
  {
    name: 'press_key',
    task: 'Press the Escape key',
    expectedAction: 'press_key',
    expectedParams: { key: true }
  },
  {
    name: 'scroll down',
    task: 'Scroll down on the page',
    expectedAction: 'scroll',
    expectedParams: { direction: true, amount: true }
  },
  {
    name: 'wait',
    task: 'Wait 5 seconds',
    expectedAction: 'wait',
    expectedParams: { time_ms: true }
  },
  {
    name: 'goto',
    task: 'Navigate to https://google.com (we are not there yet)',
    expectedAction: 'goto',
    expectedParams: { url: true }
  },
  {
    name: 'extract',
    task: 'Extract the main heading from this page',
    expectedAction: 'extract',
    expectedParams: { instruction: true }
  }
];

async function runTest(test) {
  const request = {
    model: 'rose-labs/rose-1-browser-use',
    model_seed: 3, // Use GPT-5.2 for consistent results
    task: test.task,
    browser_state: {
      url: 'https://example.com',
      title: 'Example',
      dom_tree: '[5]: <input type="text" name="q">\n[10]: <button>Submit</button>',
      viewport: { width: 1280, height: 720 },
      scroll_position: { x: 0, y: 0 },
      screenshot: null
    },
    action_history: [],
    available_actions: ['click', 'input_text', 'scroll', 'goto', 'navback', 'wait', 'done', 'press_key', 'extract']
  };

  try {
    const response = await fetch(SUPABASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'x-api-key': ROSE_API_KEY
      },
      body: JSON.stringify(request)
    });

    const data = await response.json();
    const action = data.action?.action;
    const params = data.action?.params || {};
    
    const actionOk = action === test.expectedAction;
    const paramsOk = Object.keys(test.expectedParams).every(key => params[key] !== undefined);
    
    console.log(`\n${actionOk && paramsOk ? '✅' : '❌'} ${test.name}`);
    console.log(`   Action: ${action} (expected: ${test.expectedAction}) ${actionOk ? '✓' : '✗'}`);
    console.log(`   Params: ${JSON.stringify(params)}`);
    
    for (const [key, required] of Object.entries(test.expectedParams)) {
      const hasKey = params[key] !== undefined;
      console.log(`     - ${key}: ${hasKey ? '✓' : '✗'} ${hasKey ? `(${JSON.stringify(params[key])})` : '(MISSING!)'}`);
    }
    
    return actionOk && paramsOk;
  } catch (error) {
    console.log(`\n❌ ${test.name}: ERROR - ${error.message}`);
    return false;
  }
}

async function runAllTests() {
  console.log('🧪 Testing all action/param mappings...\n');
  console.log('=' .repeat(50));
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    const result = await runTest(test);
    if (result) passed++;
    else failed++;
    
    // Small delay between tests
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log('\n' + '='.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
}

runAllTests();

