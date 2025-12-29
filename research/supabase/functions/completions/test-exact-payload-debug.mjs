/**
 * Debug test to see EXACTLY what Rose returns in SSE format
 * to match against what Python sees
 */

const ROSE_API_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';
const API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU';

// Simple payload
const payload = {
  "model": "rose-labs/rose-1-lite",
  "model_seed": 3,  // Force Haiku
  "messages": [
    {"role": "system", "content": "You are a progress evaluator. Return JSON with reasoning and response fields."},
    {"role": "user", "content": "Task: Buy a beanie. Status: Completed for $27.95. Score the progress."}
  ],
  "temperature": 0.3,
  "max_tokens": 200,
  "stream": true,
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "ProgressScore",
      "schema": {
        "type": "object",
        "properties": {
          "reasoning": {"type": "string"},
          "response": {"type": "number", "minimum": 0.0, "maximum": 1.0}
        },
        "required": ["reasoning", "response"],
        "additionalProperties": false
      },
      "strict": true
    }
  }
};

async function test() {
  console.log('🔍 Debug: Logging EXACT SSE chunks as Python would see them\n');

  const response = await fetch(ROSE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'x-api-key': API_KEY,
    },
    body: JSON.stringify(payload),
  });

  console.log(`Response status: ${response.status}\n`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lineNumber = 0;
  let extractedContent = '';
  let contentChunks = 0;

  // Simulate Python's processing exactly
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      lineNumber++;
      
      // This is EXACTLY what Python does:
      // 1. Skip empty lines
      const stripped = line.trim();
      if (!stripped) continue;
      
      // 2. Skip non-data lines
      if (!stripped.startsWith('data: ')) {
        console.log(`Line ${lineNumber}: [SKIP non-data] "${stripped.substring(0, 50)}"`);
        continue;
      }
      
      // 3. Get the data payload
      const dataPayload = stripped.slice(6);
      
      // 4. Skip [DONE]
      if (dataPayload === '[DONE]') {
        console.log(`Line ${lineNumber}: [DONE]`);
        continue;
      }
      
      // 5. Parse JSON
      let parsed;
      try {
        parsed = JSON.parse(dataPayload);
      } catch (e) {
        console.log(`Line ${lineNumber}: [PARSE ERROR] "${dataPayload.substring(0, 100)}"`);
        continue;
      }
      
      // 6. Extract content EXACTLY like Python does:
      //    delta = chunk_data.get("choices", [{}])[0].get("delta", {})
      //    content = delta.get("content", "")
      const choices = parsed.choices || [{}];
      const delta = choices[0]?.delta || {};
      const content = delta.content || '';
      
      // Show first 10 chunks in detail
      if (lineNumber <= 10) {
        console.log(`Line ${lineNumber}:`);
        console.log(`  Raw data: ${dataPayload.substring(0, 150)}${dataPayload.length > 150 ? '...' : ''}`);
        console.log(`  choices present: ${!!parsed.choices}`);
        console.log(`  delta keys: ${Object.keys(delta).join(', ') || '(none)'}`);
        console.log(`  content: "${content}"`);
      }
      
      if (content) {
        contentChunks++;
        extractedContent += content;
      }
    }
  }

  console.log(`\n📊 RESULTS (Python-style extraction):`);
  console.log(`  Total lines processed: ${lineNumber}`);
  console.log(`  Chunks with content: ${contentChunks}`);
  console.log(`  Total content length: ${extractedContent.length}`);
  console.log(`\n📝 Extracted content:\n${extractedContent}`);
}

test().catch(console.error);

