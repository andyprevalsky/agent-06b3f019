/**
 * Direct Yutori n1-latest API test
 */

const YUTORI_API_KEY = 'yt_9vPF-8hXpt8pIY_pnBJK_3w2yiw2IV-uINYJXw3jr7c';
const YUTORI_API_URL = 'https://api.yutori.com/v1/chat/completions';
const SCREENSHOT_URL =
  'https://upload.wikimedia.org/wikipedia/commons/5/53/Google_homepage_%28as_of_January_2024%29.jpg';

async function testYutoriDirect() {
  console.log('🎯 Testing Yutori n1-latest API directly...\n');

  // n1-latest format: screenshot goes in user message content
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Click on the Google Search button.',
        },
        {
          type: 'image_url',
          image_url: {
            url: SCREENSHOT_URL,
          },
        },
      ],
    },
  ];

  const requestBody = {
    model: 'n1-latest',
    messages,
    temperature: 0.3,
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
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
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

    // Parse n1-latest response: reasoning in content, actions in tool_calls
    const content = data.choices?.[0]?.message?.content;
    const toolCalls = data.choices?.[0]?.message?.tool_calls;

    if (content) {
      console.log(`\n💭 Reasoning: ${content}`);
    }

    if (toolCalls && toolCalls.length > 0) {
      console.log('\n🔧 Tool calls:');
      for (const tc of toolCalls) {
        console.log(`   Tool: ${tc.function.name}`);
        console.log(`   Args: ${tc.function.arguments}`);
      }
    } else {
      console.log('\n✅ No tool calls - model considers task done');
    }
  } catch (error) {
    console.error('❌ Request failed:', error);
  }
}

testYutoriDirect()
  .then(() => console.log('\n✅ Test completed!'))
  .catch(console.error);
