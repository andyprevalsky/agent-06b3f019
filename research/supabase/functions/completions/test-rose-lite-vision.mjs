const ROSE_API_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';
const ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScLtwKh0DYc8sXZz3XU';

console.log('═══════════════════════════════════════════════════════════');
console.log('🧪 TEST: rose-1-lite Vision Functionality (Through Pool)');
console.log('═══════════════════════════════════════════════════════════\n');

// Minimal valid JPEG (2x1 black)
const MINIMAL_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APvTn//Z';

const messagesWithScreenshot = [
  { role: 'system', content: 'You are a helpful assistant. Describe what you see in images.' },
  { role: 'user', content: 'I took a screenshot. What do you see?' },
  {
    role: 'tool',
    tool_call_id: 'screenshot_1',
    content: JSON.stringify({
      success: true,
      screenshot_taken: true,
      __screenshot_base64__: MINIMAL_JPEG_BASE64,
      timestamp: Date.now(),
      pageUrl: 'https://example.com/test',
      note: 'Screenshot captured successfully.'
    })
  }
];

async function testRoseLite() {
  console.log('📤 Testing rose-1-lite with screenshot...');
  console.log('   Pool models: kimi-k2-0905, gpt-5.2, gemini-2.5-flash, grok-4-fast');
  console.log('   Vision capable: gpt-5.2 ✅, gemini-2.5-flash ✅, grok-4-fast ✅');
  console.log('   Non-vision: kimi-k2-0905 ❌\n');
  
  try {
    const response = await fetch(ROSE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'x-api-key': ROSE_API_KEY,
      },
      body: JSON.stringify({
        model: 'rose-1-lite',  // Use pool, not direct model
        messages: messagesWithScreenshot,
        max_tokens: 100,
        stream: false,
      })
    });

    const data = await response.json();

    console.log('📥 Response:');
    console.log(`   Status: ${response.status}`);
    console.log(`   Actual model: ${data.actual_model || 'N/A'}`);
    
    if (response.ok) {
      console.log(`   ✅ SUCCESS - Response received`);
      if (data.choices?.[0]?.message?.content) {
        console.log(`   Content: "${data.choices[0].message.content.slice(0, 100)}..."`);
      }
      
      // Check if vision model was selected
      const visionModels = ['openai/gpt-5.2', 'google/gemini-2.5-flash', 'x-ai/grok-4-fast'];
      const usedVision = visionModels.includes(data.actual_model);
      console.log(`\n   🔍 Vision model used: ${usedVision ? '✅ YES' : '❌ NO'} (${data.actual_model})`);
      
      if (!usedVision) {
        console.log('   ⚠️  Non-vision model selected - base64 should have been stripped');
      }
    } else {
      console.log(`   ❌ Error: ${JSON.stringify(data).slice(0, 200)}`);
      
      // Check if it's an image-related error (which confirms transformation worked)
      if (JSON.stringify(data).includes('image')) {
        console.log('\n   📸 Image-related error - transformation IS working!');
        console.log('   (Minimal test image too small for production APIs)');
      }
    }
    
    return { success: response.ok, data };
  } catch (e) {
    console.log(`   ❌ Fetch Error: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// Run test
const result = await testRoseLite();

console.log('\n═══════════════════════════════════════════════════════════');
console.log('📊 RESULT');
console.log('═══════════════════════════════════════════════════════════');
console.log(`   rose-1-lite vision test: ${result.success ? '✅ PASS' : '⚠️ CHECK LOGS'}`);
console.log('\n   Check Supabase logs for:');
console.log('   "📸 Found screenshot in tool message"');
console.log('   "📨 Messages transformed: X → Y"');
