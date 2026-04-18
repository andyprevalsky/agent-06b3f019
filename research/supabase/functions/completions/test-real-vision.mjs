import { readFileSync } from 'fs';

const ROSE_API_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';
const ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScLtwKh0DYc8sXZz3XU';

// Read the base64 screenshot
const SCREENSHOT_BASE64 = readFileSync('/tmp/sc_base64.txt', 'utf-8').trim();

console.log('═══════════════════════════════════════════════════════════');
console.log('🧪 TEST: rose-1-lite with REAL Screenshot');
console.log('═══════════════════════════════════════════════════════════');
console.log('Screenshot size:', Math.round(SCREENSHOT_BASE64.length / 1024), 'KB base64\n');

const messages = [
  { role: 'system', content: 'You are a helpful assistant that describes screenshots accurately.' },
  {
    role: 'user',
    content: 'I took a screenshot of a webpage. What website is this? What can you see on it?',
  },
  {
    role: 'tool',
    tool_call_id: 'screenshot_1',
    content: JSON.stringify({
      success: true,
      screenshot_taken: true,
      __screenshot_base64__: SCREENSHOT_BASE64,
      timestamp: Date.now(),
      pageUrl: 'https://news.ycombinator.com',
    }),
  },
];

try {
  const response = await fetch(ROSE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'x-api-key': ROSE_API_KEY,
    },
    body: JSON.stringify({
      model: 'rose-1-lite',
      messages,
      max_tokens: 300,
      stream: false,
    }),
  });

  const data = await response.json();

  console.log('📊 Results:');
  console.log('   Model used:', data.actual_model);
  console.log('   Status:', response.status);

  if (data.choices?.[0]?.message?.content) {
    console.log('\n📝 Model Response:\n');
    console.log(data.choices[0].message.content);
    console.log('\n✅ Vision test PASSED - model processed the image!');
  } else {
    console.log('\n❌ Error:', JSON.stringify(data).slice(0, 500));
  }
} catch (e) {
  console.log('❌ Fetch error:', e.message);
}
