/**
 * Test that replays the EXACT payload from worker log line 1822 that failed
 * with "No JSON content received in response (chunks=251, model=anthropic/claude-haiku-4.5)"
 */

const ROSE_API_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';
const API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU';

// Exact payload from the failing request
const payload = {
  "model": "rose-labs/rose-1-lite",
  "messages": [
    {"role": "system", "content": "ROLE / IDENTITY\n----------------\nYou are an impartial judge evaluating a SUPER-INTELLIGENT AUTONOMOUS SYSTEM (SIAS).\n\n\nGOAL / SUCCESS CRITERIA\n----------------------------\n- Score the agent's progress from 0.0 to 1.0 based on concrete results.\n- Consider both phase completion and execution progress.\n- CURRENT PHASE: EXECUTE\n\n\nCONTEXT / CAPABILITIES\n----------------------\n- The SIAS can research, reason, spawn sub-agents, ask users for input, and coordinate complex plans.\n- It has unlimited creativity and persistence—never excuse failure as \"AI limitations.\"\n\n\nRULES / CONTROL LOGIC\n------------------------\nPhase-aware minimum scores:\n- PREPARE_RESEARCH → 0.02\n- RESEARCH → 0.05\n- ATOMIZE → 0.10\n- PLAN → 0.15\n- SPAWN → 0.20\n- EXECUTE → 0.20–1.0 based on real completion\n\nExecute-phase guidance:\n- 0.20 = just entered execute phase\n- 0.30–0.50 = some execution progress\n- 0.50–0.80 = significant progress\n- 0.80–0.99 = nearly complete\n- 1.0 = verifiable completion\n\nIntent is not completion. Research alone caps at 0.10; acquisition goals without confirmation cap at 0.20.\n\"Proceeding to checkout\" or \"order confirmed\" ≠ finished outcome.\n\n\nOUTPUT CONTRACT\n---------------\nEvaluation criteria:\nYou are judging whether the agent has achieved the following goal: \"Get me a black beanie < 35$ and well-made\"\n\nScoring Instructions:\n- Return a float between 0.0 and 1.0.\n- 0.0 means no progress or only explanations/plans.\n- 1.0 means the goal is FULLY accomplished with verifiable proof.\n- Do not award 1.0 for partial completion.\n\nOnly award 1.0 when the user would agree the goal is fully done with concrete proof.\n\nReturn JSON:\n{\n  \"reasoning\": \"<internal thinking about what was actually accomplished>\",\n  \"response\": <number between 0.0 and 1.0>\n}"},
    {"role": "user", "content": "Get me a black beanie < 35$ and well-made"},
    {"role": "system", "content": "Searched for similar goals: "},
    {"role": "assistant", "content": "**Analyzing the Search Criteria**\n\nI'm zeroing in on the task at hand. It's about finding a specific product (a black beanie) that fits a very specific criteria: It needs to be well-made, cost under $35, and be available for purchase."},
    {"role": "system", "content": "Purchase Well-Made Black Beanie Under $35: **Purchase Well-Made Black Beanie Under $35**\n\n4 tasks (parallel execution)."},
    {"role": "system", "content": "FYI for User: I've outlined a plan to get you a well-made black beanie under $35. It involves researching options, selecting one, and then making the purchase."},
    {"role": "assistant", "content": "Plan transmitted. Now shifting to EXECUTE phase to acquire the black beanie as specified."},
    {"role": "system", "content": "Web search completed: **Params Passed:**\n\n- **query**: best well-made black beanies under $35 quality materials merino wool cotton 2024\n\n**Result:**\n\nHere are some of the best-quality black beanies under $35 that use high-grade materials."},
    {"role": "assistant", "content": "<tool_calls>\n  <invoke name=\"spawn_browser_agent\">\n    <parameter name=\"goal\">Navigate to the Rustek store and purchase a black merino wool beanie under $35.</parameter>\n  </invoke>\n</tool_calls>"},
    {"role": "system", "content": "✓ Attempting completion: Excellent! The web search returned several well-qualified options under $35."},
    {"role": "system", "content": "✨ Plan Ready: Looks like I have everything I need in order to accomplish your goal."},
    {"role": "assistant", "content": "SUCCESSFUL ACQUISITION VERIFIED. The purchase of the Rustek 100% Merino Wool Waffle Beanie has been completed. It cost $27.95, has 4.8-star reviews, and is made from high-quality materials with USA construction, fulfilling the user's goal of getting a well-made black beanie for under $35. Goal has been achieved."},
    {"role": "user", "content": "Evaluate the agent's progress as JSON."}
  ],
  "temperature": 0.3,
  "max_tokens": 4096,
  "stream": true,
  "model_seed": 3,  // Force Haiku selection (index 3 in rose-1-lite pool)
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "ProgressScore",
      "schema": {
        "description": "Schema for progress evaluation.",
        "properties": {
          "reasoning": {
            "description": "Your internal thinking process about the progress",
            "title": "Reasoning",
            "type": "string"
          },
          "response": {
            "description": "Progress score from 0.0 (no progress) to 1.0 (complete)",
            "maximum": 1.0,
            "minimum": 0.0,
            "title": "Response",
            "type": "number"
          }
        },
        "required": ["reasoning", "response"],
        "title": "ProgressScore",
        "type": "object",
        "additionalProperties": false
      },
      "strict": true
    }
  }
};

async function testExactPayload() {
  console.log('🔁 Replaying exact failed payload from worker log...\n');
  console.log('Message structure:');
  payload.messages.forEach((m, i) => {
    console.log(`  ${i}: ${m.role.padEnd(10)} (${m.content.length} chars)`);
  });
  console.log('');

  try {
    const response = await fetch(ROSE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'x-api-key': API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`❌ HTTP ${response.status}: ${text}`);
      return;
    }

    console.log('📡 Streaming response started...\n');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let chunkCount = 0;
    let contentChunks = 0;
    let accumulatedJson = '';
    let selectedModel = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) continue;
        
        const data = line.slice(6);
        if (data === '[DONE]') {
          console.log('\n📊 [DONE] received');
          continue;
        }

        chunkCount++;
        try {
          const parsed = JSON.parse(data);
          
          // Check for model selection
          if (parsed.model && !selectedModel) {
            selectedModel = parsed.model;
            console.log(`🎯 Model selected: ${selectedModel}`);
          }
          
          // Extract content
          const delta = parsed.choices?.[0]?.delta || {};
          const content = delta.content || '';
          
          if (content) {
            contentChunks++;
            accumulatedJson += content;
            if (contentChunks <= 5) {
              console.log(`  Chunk ${chunkCount}: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`);
            }
          }
          
          // Log first few chunks for debugging
          if (chunkCount <= 3) {
            console.log(`  Raw chunk ${chunkCount}:`, JSON.stringify(delta).substring(0, 100));
          }
        } catch (e) {
          console.log(`  Parse error at chunk ${chunkCount}: ${e.message}`);
        }
      }
    }

    console.log(`\n📈 Results:`);
    console.log(`  Total chunks: ${chunkCount}`);
    console.log(`  Chunks with content: ${contentChunks}`);
    console.log(`  Accumulated JSON length: ${accumulatedJson.length}`);
    console.log(`  Selected model: ${selectedModel}`);
    
    if (accumulatedJson.length > 0) {
      console.log(`\n✅ SUCCESS - Got JSON content:`);
      console.log(accumulatedJson);
      
      try {
        const result = JSON.parse(accumulatedJson);
        console.log(`\n📊 Parsed result:`);
        console.log(`  reasoning: ${result.reasoning?.substring(0, 100)}...`);
        console.log(`  response: ${result.response}`);
      } catch (e) {
        console.log(`  ⚠️ JSON parse failed: ${e.message}`);
      }
    } else {
      console.log(`\n❌ FAILURE - No JSON content received!`);
      console.log(`  This reproduces the bug from the worker log.`);
    }

  } catch (error) {
    console.error('❌ Request failed:', error.message);
  }
}

testExactPayload();

