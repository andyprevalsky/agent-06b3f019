// Test rose-lite streaming with all required headers
const SUPABASE_URL = "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU";
const ROSE_API_KEY = "af1ea4b12ea8dbe07c555a45a8ad4dc8";

async function testRoseLite() {
  console.log("🧪 Testing rose-lite streaming...\n");
  
  const requestBody = {
    model: "rose-labs/rose-1-lite",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Say hello in exactly 3 words." }
    ],
    stream: true,
    max_tokens: 100
  };
  
  console.log("📤 Request:", JSON.stringify(requestBody, null, 2));
  console.log("\n--- Streaming response ---\n");
  
  const startTime = Date.now();
  let chunkCount = 0;
  let fullContent = "";
  let rawChunks = [];
  
  try {
    const response = await fetch(SUPABASE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "x-api-key": ROSE_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
    
    console.log(`📥 Response status: ${response.status}`);
    console.log(`📥 Content-Type: ${response.headers.get('content-type')}`);
    
    if (!response.ok) {
      const text = await response.text();
      console.log(`❌ Error response: ${text}`);
      return;
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      chunkCount++;
      rawChunks.push(chunk);
      
      // Show first 15 chunks in detail
      if (chunkCount <= 15) {
        console.log(`[Chunk ${chunkCount}]: "${chunk.replace(/\n/g, '\\n').substring(0, 400)}"`);
      } else if (chunkCount % 50 === 0) {
        console.log(`[Chunk ${chunkCount}]...`);
      }
      
      // Try to parse SSE data
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) fullContent += content;
          } catch (e) {
            // Not JSON, skip
          }
        }
      }
    }
    
    const totalTime = Date.now() - startTime;
    console.log(`\n--- Summary ---`);
    console.log(`✅ Total chunks: ${chunkCount}`);
    console.log(`⏱️  Total time: ${totalTime}ms`);
    console.log(`📝 Extracted content: "${fullContent}"`);
    
    // Show last few chunks if no content extracted
    if (!fullContent && chunkCount > 0) {
      console.log(`\n⚠️  No content extracted! Last 5 raw chunks:`);
      rawChunks.slice(-5).forEach((c, i) => {
        console.log(`  [${rawChunks.length - 4 + i}]: "${c.substring(0, 500)}"`);
      });
    }
    
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    console.log(error.stack);
  }
}

testRoseLite();
