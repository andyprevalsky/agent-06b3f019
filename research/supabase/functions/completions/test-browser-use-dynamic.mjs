// Test browser-use with dynamic available_actions
const SUPABASE_URL = "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU";
const ROSE_API_KEY = "af1ea4b12ea8dbe07c555a45a8ad4dc8";

async function testBrowserUseDynamic() {
  console.log("🧪 Testing browser-use with dynamic available_actions...\n");
  
  // Sample request matching Python agent format
  const requestBody = {
    model: "rose-labs/rose-1-browser-use",
    task: "Go to google.com and search for 'browser automation'",
    browser_state: {
      url: "about:blank",
      dom_tree: "[1]<button>Example Button</button>\n[2]<input type='text' placeholder='Search'>",
      viewport: { width: 1280, height: 720 },
      scroll_position: { x: 0, y: 0 },
      title: "New Tab"
    },
    action_history: [],
    // Python agent's available actions
    available_actions: [
      "click",
      "input_text",  // Python name
      "scroll",
      "goto",        // Python name  
      "navback",     // Python name
      "wait",
      "done",
      "extract",
      "press_key"    // Python name
    ],
    model_seed: 3  // Use generic LLM (index 3) to see the system prompt
  };
  
  console.log("📤 Request available_actions:", requestBody.available_actions);
  console.log("");
  
  try {
    const response = await fetch(SUPABASE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "x-api-key": ROSE_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
    
    console.log(`📥 Response status: ${response.status}`);
    
    if (!response.ok) {
      const text = await response.text();
      console.log(`❌ Error: ${text.slice(0, 500)}`);
      return;
    }
    
    const data = await response.json();
    console.log(`\n📥 Response:`);
    console.log(JSON.stringify(data, null, 2));
    
    // Check if action was returned
    if (data.action) {
      console.log(`\n✅ Action returned: ${data.action.action}`);
      if (data.action.params) {
        console.log(`   Params: ${JSON.stringify(data.action.params)}`);
      }
    }
    
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
  }
}

testBrowserUseDynamic();



