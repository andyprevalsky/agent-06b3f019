/**
 * Debug test to see exactly what chunks Rose sends for Haiku structured output.
 */

const ROSE_API_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';
const API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU';

const PROGRESS_SCORE_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    response: { type: "number", minimum: 0.0, maximum: 1.0 }
  },
  required: ["reasoning", "response"],
  additionalProperties: false
};

async function debugChunks() {
  console.log('🔍 Debug: Testing Haiku structured output streaming chunks\n');
  
  const requestBody = {
    model: 'rose-labs/rose-1-lite',
    model_seed: 3,  // Force Haiku
    messages: [
      { role: "system", content: "You are a progress verifier. Return JSON with reasoning and response (score)." },
      { role: "user", content: "Task: Buy a black beanie. Status: Done, purchased for $27.95. Evaluate progress." }
    ],
    max_tokens: 200,
    temperature: 0.3,
    stream: true,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'ProgressScore',
        schema: PROGRESS_SCORE_SCHEMA,
        strict: true
      }
    }
  };
  
  const response = await fetch(ROSE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'x-api-key': API_KEY
    },
    body: JSON.stringify(requestBody)
  });
  
  if (!response.ok) {
    console.error(`HTTP Error: ${response.status}`);
    const text = await response.text();
    console.error(text);
    return;
  }
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chunkCount = 0;
  let contentChunks = 0;
  let emptyContentChunks = 0;
  let accumulatedContent = '';
  
  console.log('Receiving chunks...\n');
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          console.log('\n[DONE]');
          continue;
        }
        
        chunkCount++;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta || {};
          const content = delta.content;
          
          // Log first 5 chunks and any with content
          if (chunkCount <= 5 || content) {
            console.log(`Chunk ${chunkCount}:`, JSON.stringify({
              actual_model: parsed.actual_model,
              pool_name: parsed.pool_name,
              delta_keys: Object.keys(delta),
              content_length: content?.length || 0,
              content_preview: content?.slice(0, 50)
            }));
          }
          
          if (content) {
            contentChunks++;
            accumulatedContent += content;
          } else {
            emptyContentChunks++;
          }
        } catch (e) {
          console.log(`Chunk ${chunkCount}: [parse error] ${data.slice(0, 100)}`);
        }
      }
    }
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('SUMMARY:');
  console.log(`  Total chunks: ${chunkCount}`);
  console.log(`  Chunks with content: ${contentChunks}`);
  console.log(`  Chunks with empty content: ${emptyContentChunks}`);
  console.log(`  Total content length: ${accumulatedContent.length}`);
  console.log('\nFull content:');
  console.log(accumulatedContent);
}

debugChunks().catch(console.error);

