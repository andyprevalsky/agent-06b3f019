/**
 * Test to reproduce the Haiku structured output streaming bug.
 * 
 * Bug: When using Anthropic models with output_format (JSON schema),
 * Anthropic sends json_delta events with partial_json field, but Rose
 * only extracts delta.text (for text_delta), resulting in empty content.
 * 
 * Usage: node test-haiku-structured-streaming.mjs
 */

const ROSE_API_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';
const API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU';

// ProgressScore schema (same as verifier uses)
const PROGRESS_SCORE_SCHEMA = {
  type: "object",
  properties: {
    reasoning: {
      type: "string",
      description: "Explanation of the progress assessment"
    },
    response: {
      type: "number",
      description: "Progress score from 0.0 to 1.0"
    }
  },
  required: ["reasoning", "response"],
  additionalProperties: false
};

async function testStructuredStreaming(modelSeed, modelName) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing model_seed=${modelSeed} (${modelName})`);
  console.log('='.repeat(60));
  
  const messages = [
    {
      role: "system",
      content: "You are a progress verifier. Assess the completion of the given task and provide a score."
    },
    {
      role: "user",
      content: "Task: Buy a black beanie under $35.\n\nActions taken: Searched for beanies, found Rustek Merino Wool Beanie for $27.95, added to cart, completed checkout.\n\nAssess the progress toward completing this task."
    }
  ];
  
  const requestBody = {
    model: 'rose-labs/rose-1-lite',
    model_seed: modelSeed,  // Force specific model
    messages,
    max_tokens: 500,
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
  
  console.log(`📤 Sending streaming request to Rose...`);
  
  try {
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
      const errorText = await response.text();
      console.error(`❌ HTTP Error: ${response.status}`);
      console.error(errorText);
      return { success: false, error: `HTTP ${response.status}` };
    }
    
    // Process SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let chunkCount = 0;
    let accumulatedContent = '';
    let actualModel = 'unknown';
    let firstChunkTime = null;
    const startTime = Date.now();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          
          try {
            const parsed = JSON.parse(data);
            chunkCount++;
            
            if (chunkCount === 1) {
              firstChunkTime = Date.now() - startTime;
              console.log(`⏱️  TTFT: ${firstChunkTime}ms`);
            }
            
            // Extract actual model from first chunk
            if (parsed.actual_model && actualModel === 'unknown') {
              actualModel = parsed.actual_model;
              console.log(`🎯 Actual model: ${actualModel}`);
            }
            
            // Extract content
            const delta = parsed.choices?.[0]?.delta || {};
            const content = delta.content || '';
            
            if (content) {
              accumulatedContent += content;
            }
            
            // Log every 50 chunks
            if (chunkCount % 50 === 0) {
              console.log(`📦 Chunk ${chunkCount}: accumulated=${accumulatedContent.length} chars`);
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }
    
    const totalTime = Date.now() - startTime;
    
    console.log(`\n📊 Results:`);
    console.log(`   Model: ${actualModel}`);
    console.log(`   Chunks received: ${chunkCount}`);
    console.log(`   Content accumulated: ${accumulatedContent.length} chars`);
    console.log(`   Total time: ${totalTime}ms`);
    
    if (accumulatedContent.length === 0) {
      console.log(`\n❌ BUG REPRODUCED: ${chunkCount} chunks but 0 content!`);
      console.log(`   This confirms the json_delta handling issue.`);
      return { success: false, error: 'No content accumulated', chunkCount, model: actualModel };
    } else {
      console.log(`\n✅ Content received successfully`);
      console.log(`   Preview: ${accumulatedContent.slice(0, 200)}...`);
      
      // Try to parse as JSON
      try {
        const parsed = JSON.parse(accumulatedContent);
        console.log(`   Parsed score: ${parsed.response}`);
        console.log(`   Reasoning: ${parsed.reasoning?.slice(0, 100)}...`);
      } catch (e) {
        console.log(`   (Content not yet valid JSON)`);
      }
      
      return { success: true, content: accumulatedContent, chunkCount, model: actualModel };
    }
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function main() {
  console.log('🧪 Haiku Structured Output Streaming Bug Reproduction Test');
  console.log('============================================================\n');
  
  // Test with different models from rose-1-lite pool:
  // Index 0: moonshotai/kimi-k2-0905
  // Index 1: openai/gpt-5.2  
  // Index 2: google/gemini-2.5-flash
  // Index 3: anthropic/claude-haiku-4.5 (EXPECTED TO FAIL)
  
  const tests = [
    { seed: 0, name: 'moonshotai/kimi-k2-0905' },
    { seed: 3, name: 'anthropic/claude-haiku-4.5' },  // Bug case
  ];
  
  const results = [];
  
  for (const test of tests) {
    const result = await testStructuredStreaming(test.seed, test.name);
    results.push({ ...test, ...result });
  }
  
  // Summary
  console.log('\n\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  
  for (const r of results) {
    const status = r.success ? '✅' : '❌';
    console.log(`${status} ${r.name}: ${r.success ? `${r.content?.length || 0} chars` : r.error}`);
  }
  
  // Check if bug is reproduced
  const haikuResult = results.find(r => r.name.includes('haiku'));
  const kimiResult = results.find(r => r.name.includes('kimi'));
  
  if (kimiResult?.success && !haikuResult?.success) {
    console.log('\n🐛 BUG CONFIRMED: Kimi works, Haiku fails with structured streaming.');
    console.log('   Root cause: Rose only handles delta.text, not delta.partial_json');
    process.exit(1);  // Exit with error to indicate bug
  } else if (haikuResult?.success) {
    console.log('\n✅ BUG FIXED: Haiku structured streaming now works!');
    process.exit(0);
  }
}

main().catch(console.error);

