/**
 * Test with message structure matching the failing verifier from worker log.
 * The worker log showed 13 messages with many system roles.
 */

const ROSE_API_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';
const API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU';

const PROGRESS_SCORE_SCHEMA = {
  description: "Schema for progress evaluation.",
  properties: {
    reasoning: {
      description: "Your internal thinking process about the progress",
      title: "Reasoning",
      type: "string"
    },
    response: {
      description: "Progress score from 0.0 (no progress) to 1.0 (complete)",
      maximum: 1.0,
      minimum: 0.0,
      title: "Response",
      type: "number"
    }
  },
  required: ["reasoning", "response"],
  title: "ProgressScore",
  type: "object",
  additionalProperties: false
};

// Replicate the exact message structure from the failing worker log
const messages = [
  { role: "system", content: "ROLE / IDENTITY\n----------------\nYou are an impartial judge evaluating a SUPER-INTELLIGENT AUTONOMOUS SYSTEM (SIAS).\n\n\nGOAL / SUCCESS CRITERIA\n----------------------------\n- Score the agent's progress from 0.0 to 1.0 based on concrete results.\n- Consider both phase completion and execution progress.\n- CURRENT PHASE: EXECUTE\n\nReturn JSON:\n{\n  \"reasoning\": \"<internal thinking>\",\n  \"response\": <number between 0.0 and 1.0>\n}" },
  { role: "user", content: "Get me a black beanie < 35$ and well-made" },
  { role: "system", content: "Searched for similar goals: " },
  { role: "assistant", content: "**Analyzing the Search Criteria**\n\nI'm zeroing in on the task at hand." },
  { role: "system", content: "Purchase Well-Made Black Beanie Under $35: **Purchase Well-Made Black Beanie Under $35**\n\n4 tasks (parallel execution)." },
  { role: "system", content: "FYI for User: I've outlined a plan to get you a well-made black beanie under $35." },
  { role: "assistant", content: "Plan transmitted. Now shifting to EXECUTE phase." },
  { role: "system", content: "Web search completed: Here are some options under $35..." },
  { role: "assistant", content: "<tool_calls>\n  <invoke name=\"spawn_browser_agent\">\n    <parameter name=\"goal\">Navigate to Rustek store...</parameter>\n  </invoke>\n</tool_calls>" },
  { role: "system", content: "✓ Attempting completion: Excellent! The web search returned several well-qualified options." },
  { role: "system", content: "✨ Plan Ready: Looks like I have everything I need." },
  { role: "assistant", content: "SUCCESSFUL ACQUISITION VERIFIED. The purchase of the Rustek 100% Merino Wool Waffle Beanie has been completed." },
  { role: "user", content: "Evaluate the agent's progress as JSON." }
];

async function testVerifierContext() {
  console.log('🔍 Testing with verifier message structure (13 messages)\n');
  console.log(`Messages: ${messages.length} total`);
  console.log(`Roles: ${messages.map(m => m.role).join(', ')}\n`);
  
  const requestBody = {
    model: 'rose-labs/rose-1-lite',
    model_seed: 3,  // Force Haiku
    messages,
    temperature: 0.3,
    max_tokens: 4096,
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
  let accumulatedContent = '';
  let actualModel = 'unknown';
  
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
        
        chunkCount++;
        try {
          const parsed = JSON.parse(data);
          if (parsed.actual_model) actualModel = parsed.actual_model;
          const content = parsed.choices?.[0]?.delta?.content || '';
          accumulatedContent += content;
        } catch (e) {}
      }
    }
  }
  
  console.log('RESULTS:');
  console.log(`  Model: ${actualModel}`);
  console.log(`  Chunks: ${chunkCount}`);
  console.log(`  Content length: ${accumulatedContent.length}`);
  
  if (accumulatedContent.length === 0) {
    console.log('\n❌ BUG REPRODUCED: Chunks received but no content!');
    process.exit(1);
  } else {
    console.log('\n✅ Success! Content received.');
    console.log(`  Preview: ${accumulatedContent.slice(0, 200)}`);
    
    try {
      const parsed = JSON.parse(accumulatedContent);
      console.log(`  Score: ${parsed.response}`);
    } catch (e) {
      console.log('  (Could not parse as JSON)');
    }
  }
}

// Run test 3 times to check for intermittency
async function main() {
  for (let i = 1; i <= 3; i++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`RUN ${i}/3`);
    console.log('='.repeat(60));
    await testVerifierContext();
    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(console.error);




