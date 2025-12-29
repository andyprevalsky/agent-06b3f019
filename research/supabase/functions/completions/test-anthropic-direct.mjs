/**
 * Test Anthropic API DIRECTLY to see what format they send for structured output
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY env var required');
  process.exit(1);
}

async function testAnthropicDirect() {
  console.log('🔍 Testing Anthropic API DIRECTLY with JSON schema output\n');
  
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'output-format-2025-01-24'  // Enable JSON schema output
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 200,
      stream: true,
      messages: [
        {role: 'user', content: 'Score this task. Task: Buy a beanie. Status: Done for $27.95. Return JSON with reasoning and response (score 0-1).'}
      ],
      output_format: {
        type: 'json_schema',
        json_schema: {
          name: 'ProgressScore',
          schema: {
            type: 'object',
            properties: {
              reasoning: {type: 'string'},
              response: {type: 'number'}
            },
            required: ['reasoning', 'response'],
            additionalProperties: false
          }
        }
      }
    })
  });

  console.log(`Status: ${response.status}`);
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventNum = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      if (!event.trim()) continue;
      
      eventNum++;
      const lines = event.split('\n');
      let eventType = null;
      let eventData = null;
      
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7);
        } else if (line.startsWith('data: ')) {
          try {
            eventData = JSON.parse(line.slice(6));
          } catch (e) {}
        }
      }
      
      // Only log content_block_delta events (the important ones)
      if (eventType === 'content_block_delta' && eventNum <= 10) {
        console.log(`\nEvent ${eventNum}: ${eventType}`);
        console.log(`  delta keys: ${Object.keys(eventData?.delta || {}).join(', ')}`);
        console.log(`  delta.text: "${eventData?.delta?.text}"`);
        console.log(`  delta.partial_json: "${eventData?.delta?.partial_json}"`);
        console.log(`  Full delta: ${JSON.stringify(eventData?.delta)}`);
      }
    }
  }
  
  console.log(`\n📊 Total events: ${eventNum}`);
}

testAnthropicDirect().catch(console.error);

