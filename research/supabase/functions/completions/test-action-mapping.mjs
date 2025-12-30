// Test that action name mappings work correctly
// This tests the normalization logic

const SUPABASE_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU';
const ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';

// Mock responses that simulate what each LLM returns
// We'll test by looking at the action mappings in logs

async function testMapping() {
  console.log('🧪 Testing action name mappings...\n');
  
  // Test with a prompt that should trigger a type action
  const request = {
    model: 'rose-labs/rose-1-browser-use',
    model_seed: 3, // Use GPT-5.2 for consistent results
    task: 'Type "hello world" into the search box at index 5',
    browser_state: {
      url: 'https://google.com',
      title: 'Google',
      dom_tree: '[5]: <input type="text" name="q" placeholder="Search">',
      viewport: { width: 1280, height: 720 },
      scroll_position: { x: 0, y: 0 },
      screenshot: null
    },
    action_history: [],
    available_actions: ['click', 'input_text', 'scroll', 'goto', 'navback', 'wait', 'done', 'press_key']
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
    console.log('📥 Response:', JSON.stringify(data, null, 2));
    
    const action = data.action?.action;
    const params = data.action?.params;
    
    console.log('\n✅ Validation:');
    console.log(`   Action: ${action} (expected: input_text)`);
    console.log(`   Params: ${JSON.stringify(params)}`);
    
    if (action === 'input_text' && params?.text) {
      console.log('\n🎉 Mapping works correctly!');
    } else if (action === 'type') {
      console.log('\n❌ BUG: Action still returns "type" instead of "input_text"');
    } else {
      console.log('\n⚠️ Different action returned - may need manual verification');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testMapping();

