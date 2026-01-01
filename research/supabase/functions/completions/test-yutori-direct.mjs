/**
 * Direct Yutori n1 API test (matching Python format exactly)
 */

const YUTORI_API_KEY = 'yt_9vPF-8hXpt8pIY_pnBJK_3w2yiw2IV-uINYJXw3jr7c';
const YUTORI_API_URL = 'https://api.yutori.com/v1/chat/completions';
const SCREENSHOT_URL = 'https://upload.wikimedia.org/wikipedia/commons/5/53/Google_homepage_%28as_of_January_2024%29.jpg';

async function testYutoriDirect() {
  console.log('🎯 Testing Yutori n1 API directly...\n');
  
  // Match Python test format exactly
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Click on the Google Search button.'
        }
      ]
    },
    {
      role: 'observation',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: SCREENSHOT_URL
          }
        }
      ]
    }
  ];
  
  const requestBody = {
    model: 'n1-preview-2025-11',
    messages,
    temperature: 0.3
  };
  
  console.log('📤 Request:');
  console.log(JSON.stringify(requestBody, null, 2));
  console.log('\n');
  
  const startTime = Date.now();
  
  try {
    const response = await fetch(YUTORI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${YUTORI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Parse the content
    const content = data.choices?.[0]?.message?.content;
    if (content) {
      console.log('\n📝 Parsed content:');
      try {
        const parsed = JSON.parse(content);
        console.log(`   Thoughts: ${parsed.thoughts}`);
        console.log(`   Actions: ${JSON.stringify(parsed.actions)}`);
      } catch {
        console.log(`   Raw: ${content}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Request failed:', error);
  }
}

testYutoriDirect()
  .then(() => console.log('\n✅ Test completed!'))
  .catch(console.error);




