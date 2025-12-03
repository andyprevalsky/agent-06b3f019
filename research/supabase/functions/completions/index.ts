import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};

// Model pools for Rose variants - sync with backend/src/routes/rose.ts
const MODEL_POOLS = {
  'rose-1-fast': [
    'openai/gpt-oss-120b',
    // 'qwen/qwen3-235b-a22b-thinking-2507', // Disabled - produces garbage tool calls disconnected from reasoning
    'moonshotai/kimi-k2-0905',
    'meta-llama/llama-4-maverick',
    'deepseek/deepseek-v3.2-exp',
    // 'z-ai/glm-4.6', // Disabled - causes tool call confusion (calls wrong tools)
    'openai/gpt-5.1',
    'mistralai/mistral-medium-3.1',
    'google/gemini-2.5-flash',
    'nousresearch/hermes-4-405b',
    'minimax/minimax-m2',
    'x-ai/grok-4-fast'
  ],
  'rose-1-ultra': [
    'openai/gpt-5.1',
    'anthropic/claude-sonnet-4.5',
    'moonshotai/kimi-k2-thinking',
    'google/gemini-2.5-pro',
    'x-ai/grok-4-fast'
  ],
  // Cerebras-powered hyper model - direct API calls for ultra-fast inference
  'rose-hyper': [
    'gpt-oss-120b',                    // $0.35 input, $0.75 output per 1M tokens
    'qwen-3-235b-a22b-instruct-2507',  // $0.60 input, $1.20 output per 1M tokens
  ]
};

// Cerebras API base URL (OpenAI-compatible)
const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';

// Transform JSON schema to be Cerebras-compatible
// Cerebras requires: additionalProperties: false for all objects with required arrays
// See: https://inference-docs.cerebras.ai/capabilities/structured-outputs
function transformSchemaForCerebras(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const transformed = { ...schema };

  // If it's an object type with properties, add additionalProperties: false
  if (transformed.type === 'object' && transformed.properties) {
    transformed.additionalProperties = false;
    
    // Cerebras requires all properties to be in required array
    if (!transformed.required) {
      transformed.required = Object.keys(transformed.properties);
    }
    
    // Recursively transform nested properties
    for (const key of Object.keys(transformed.properties)) {
      transformed.properties[key] = transformSchemaForCerebras(transformed.properties[key]);
    }
  }

  // Handle $defs (definitions)
  if (transformed.$defs) {
    for (const key of Object.keys(transformed.$defs)) {
      transformed.$defs[key] = transformSchemaForCerebras(transformed.$defs[key]);
    }
  }

  // Handle array items
  if (transformed.type === 'array' && transformed.items) {
    transformed.items = transformSchemaForCerebras(transformed.items);
  }

  // Handle anyOf/oneOf/allOf
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (transformed[keyword] && Array.isArray(transformed[keyword])) {
      transformed[keyword] = transformed[keyword].map((item: any) => transformSchemaForCerebras(item));
    }
  }

  return transformed;
}

// Check if a model pool uses Cerebras
function isCerebrasPool(poolName: string): boolean {
  return poolName === 'rose-hyper';
}

// Select a model from the pool (random or by seed index)
function selectModel(requestedModel: string, modelSeed?: number): { model: string; isCerebras: boolean; poolName: string; poolSize: number } {
  let normalized = requestedModel.toLowerCase();
  if (normalized.startsWith('rose-labs/')) {
    normalized = normalized.replace('rose-labs/', '');
  }
  
  const pool = MODEL_POOLS[normalized as keyof typeof MODEL_POOLS];
  
  if (!pool) {
    throw new Error(`Unknown model: ${requestedModel}. Use 'rose-labs/rose-1-fast', 'rose-labs/rose-1-ultra', or 'rose-labs/rose-hyper'`);
  }
  
  // If model_seed is provided, use it to select a specific model
  if (modelSeed !== undefined) {
    if (modelSeed < 0 || modelSeed >= pool.length) {
      throw new Error(`model_seed ${modelSeed} out of range. Pool '${normalized}' has ${pool.length} models (valid range: 0-${pool.length - 1})`);
    }
    const selectedModel = pool[modelSeed];
    const isCerebras = isCerebrasPool(normalized);
    console.log(`🎯 Model selection (seed=${modelSeed}): ${requestedModel} → ${selectedModel} (Cerebras: ${isCerebras})`);
    return { model: selectedModel, isCerebras, poolName: normalized, poolSize: pool.length };
  }
  
  const selectedModel = pool[Math.floor(Math.random() * pool.length)];
  const isCerebras = isCerebrasPool(normalized);
  console.log(`🎲 Model selection: ${requestedModel} → ${selectedModel} (Cerebras: ${isCerebras})`);
  return { model: selectedModel, isCerebras, poolName: normalized, poolSize: pool.length };
}

// Validate API key and return user info
async function validateApiKey(apiKey: string, supabase: any): Promise<{ apiKeyId: string, userId: string } | null> {
  console.log('🔍 Validating API key:', apiKey.substring(0, 8) + '...');
  
  const { data, error } = await supabase
    .from('RoseApiKey')
    .select('id, userId')
    .eq('apiKey', apiKey)
    .single();
  
  if (error || !data) {
    console.error('❌ API key validation failed:', error?.message || 'No data found');
    console.error('   Error details:', error);
    return null;
  }
  
  console.log('✓ API key validated for userId:', data.userId);
  return { apiKeyId: data.id, userId: data.userId };
}

// Calculate cost based on token usage
function calculateCost(promptTokens: number, completionTokens: number, model: string): number {
  // Simplified cost calculation - in production, fetch actual pricing
  const costPerMillionPrompt = 50; // $0.50 per million
  const costPerMillionCompletion = 150; // $1.50 per million
  
  const promptCost = (promptTokens / 1000000) * costPerMillionPrompt;
  const completionCost = (completionTokens / 1000000) * costPerMillionCompletion;
  
  return Math.ceil((promptCost + completionCost) * 100); // Return in cents
}

// Log usage to database
async function logUsage(supabase: any, apiKeyId: string, userId: string, input: any, output: any, costCents: number, cotSteps: number) {
  const { error } = await supabase
    .from('RoseApiKeyLog')
    .insert({
      apiKeyId,
      userId,
      input,
      output,
      costCents,
      cotSteps
    });
  
  if (error) {
    console.error('Failed to log usage:', error);
  }
}

// Handle streaming response
async function handleStreaming(
  actualModel: string,
  messages: any[],
  temperature: number | undefined,
  maxTokens: number | undefined,
  seed: number | undefined,
  tools: any[] | undefined,
  toolChoice: any,
  openRouterKey: string,
  supabaseUrl: string,
  requestedModel: string,
  isCerebras: boolean
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        let response: globalThis.Response;
        
        if (isCerebras) {
          // Call Cerebras API directly for rose-hyper
          const cerebrasKey = Deno.env.get('CEREBRAS_API_KEY');
          console.log(`⚡ Streaming from Cerebras API with model: ${actualModel}`);
          
          // Build Cerebras streaming request - supports tools with gpt-oss-120b
          const cerebrasStreamBody: any = {
            model: actualModel,
            messages,
            temperature,
            max_tokens: maxTokens,
            stream: true
          };
          
          // Add tools for streaming (gpt-oss-120b supports this)
          if (tools && tools.length > 0) {
            cerebrasStreamBody.tools = tools;
          }
          if (toolChoice) {
            cerebrasStreamBody.tool_choice = toolChoice;
          }
          
          response = await fetch(CEREBRAS_API_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${cerebrasKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(cerebrasStreamBody)
          });
        } else {
          // Call OpenRouter API for other Rose models
          response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${openRouterKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': supabaseUrl,
              'X-Title': 'Rose Benchmark Suite'
            },
            body: JSON.stringify({
              model: actualModel,
              messages,
              temperature,
              max_tokens: maxTokens,
              seed,
              tools,
              tool_choice: toolChoice,
              stream: true
            })
          });
        }

        if (!response.ok) {
          const provider = isCerebras ? 'Cerebras' : 'OpenRouter';
          throw new Error(`${provider} API error: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                continue;
              }
              
              try {
                const parsed = JSON.parse(data);
                // Include actual model for debugging (unmasked)
                parsed.requested_model = requestedModel;
                parsed.actual_model = actualModel;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
              } catch (e) {
                console.error('Error parsing streaming data:', e);
              }
            }
          }
        }
      } catch (error) {
        console.error('Streaming error:', error);
        controller.error(error);
      }
    }
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// Main handler
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Extract API key from header
    const apiKey = req.headers.get('x-api-key');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Missing x-api-key header' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Validate API key
    const authInfo = await validateApiKey(apiKey, supabase);
    if (!authInfo) {
      return new Response(JSON.stringify({ error: 'Invalid API key' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    // Parse request body
    const { 
      model, 
      messages: originalMessages, 
      temperature, 
      max_tokens, 
      seed,
      stream = false,
      tools,
      tool_choice,
      cot_steps,
      response_format,
      model_seed,  // Optional: index into model pool for testing
      ...otherParams
    } = await req.json();
    
    const cotSteps = cot_steps || 1;
    const maxTokens = max_tokens;
    let messages = originalMessages;

    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing required field: model' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing or invalid required field: messages' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    // Select actual model from pool
    let selection: { model: string; isCerebras: boolean; poolName: string; poolSize: number };
    try {
      selection = selectModel(model, model_seed);
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Invalid model' 
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const actualModel = selection.model;
    const isCerebras = selection.isCerebras;

    // Handle streaming
    if (stream) {
      return await handleStreaming(
        actualModel,
        messages,
        temperature,
        maxTokens,
        seed,
        tools,
        tool_choice,
        Deno.env.get('OPENROUTER_API_KEY')!,
        supabaseUrl,
        model,
        isCerebras
      );
    }

    // Handle CoT steps (non-streaming)
    let finalResponse: any;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // Helper function to make API call to appropriate provider
    async function makeApiCall(body: any): Promise<globalThis.Response> {
      if (isCerebras) {
        console.log(`⚡ Calling Cerebras API with model: ${actualModel}`);
        
        // Build Cerebras request body - Cerebras is OpenAI-compatible but doesn't support some params
        // See: https://inference-docs.cerebras.ai/resources/openai
        const cerebrasBody: any = {
          model: body.model,
          messages: body.messages,
          temperature: body.temperature,
          max_tokens: body.max_tokens,
          seed: body.seed,
        };
        
        // Add tools if provided - Cerebras supports tool calling
        // See: https://inference-docs.cerebras.ai/capabilities/tool-use
        if (body.tools && body.tools.length > 0) {
          cerebrasBody.tools = body.tools;
          // Note: parallel_tool_calls is NOT supported by Cerebras - causes 400 error
        }
        if (body.tool_choice) {
          cerebrasBody.tool_choice = body.tool_choice;
        }
        
        // Add response_format if provided - Cerebras supports structured outputs
        // See: https://inference-docs.cerebras.ai/capabilities/structured-outputs
        // Important: Cerebras requires additionalProperties: false for all objects with required
        if (body.response_format) {
          // Transform schema to be Cerebras-compatible
          if (body.response_format.type === 'json_schema' && body.response_format.json_schema?.schema) {
            const transformedSchema = transformSchemaForCerebras(body.response_format.json_schema.schema);
            cerebrasBody.response_format = {
              type: 'json_schema',
              json_schema: {
                name: body.response_format.json_schema.name || 'response',
                strict: true,
                schema: transformedSchema
              }
            };
          } else {
            cerebrasBody.response_format = body.response_format;
          }
        }
        
        console.log(`📤 Cerebras request body:`, JSON.stringify(cerebrasBody, null, 2));
        
        return await fetch(CEREBRAS_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('CEREBRAS_API_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(cerebrasBody)
        });
      } else {
        return await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('OPENROUTER_API_KEY')}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': supabaseUrl,
            'X-Title': 'Rose Benchmark Suite'
          },
          body: JSON.stringify(body)
        });
      }
    }

    if (cotSteps === 1) {
      // Direct answer (no CoT)
      const requestBody: any = {
        model: actualModel,
        messages,
        temperature,
        max_tokens: maxTokens,
        seed,
        tools,
        tool_choice,
      };
      
      // Add response_format if provided
      if (response_format) {
        requestBody.response_format = response_format;
      }
      
      // Add other params only for non-Cerebras (some params like parallel_tool_calls cause 400 on Cerebras)
      if (!isCerebras) {
        Object.assign(requestBody, otherParams);
      }

      const apiResponse = await makeApiCall(requestBody);

      if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        const provider = isCerebras ? 'Cerebras' : 'OpenRouter';
        console.error(`${provider} API error:`, apiResponse.status, errorText);
        console.error(`Request body was:`, JSON.stringify(requestBody, null, 2));
        
        // Try to parse error for more details
        let errorDetails = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorDetails = JSON.stringify(errorJson, null, 2);
          console.error(`${provider} error details:`, errorJson);
        } catch (e) {
          // errorText is not JSON, keep as-is
        }
        
        return new Response(JSON.stringify({ 
          error: `${provider} API error`,
          status: apiResponse.status,
          details: errorDetails 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: apiResponse.status,
        });
      }

      finalResponse = await apiResponse.json();
      totalPromptTokens = finalResponse.usage?.prompt_tokens || 0;
      totalCompletionTokens = finalResponse.usage?.completion_tokens || 0;

    } else {
      // Multi-step CoT (tool calls not supported with CoT currently)
      const thinkingMessages = [...messages];
      const intermediateResponses = [];
      const provider = isCerebras ? 'Cerebras' : 'OpenRouter';

      // Thinking steps (N-1 steps)
      for (let i = 0; i < cotSteps - 1; i++) {
        const thinkingPrompt = {
          role: "system",
          content: `Think step by step. You have ${cotSteps - 1} thinking steps before giving your final answer. This is thinking step ${i + 1}. Show your reasoning.`
        };

        const stepMessages = [...thinkingMessages, thinkingPrompt];

        const stepResponse = await makeApiCall({
          model: actualModel,
          messages: stepMessages,
          temperature,
          max_tokens: maxTokens,
          seed,
        });

        if (!stepResponse.ok) {
          const errorText = await stepResponse.text();
          console.error(`${provider} API error in CoT step:`, stepResponse.status, errorText);
          return new Response(JSON.stringify({ 
            error: `${provider} API error in CoT step`,
            details: errorText 
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: stepResponse.status,
          });
        }

        const stepData = await stepResponse.json();
        intermediateResponses.push(stepData);
        
        // Add assistant's thinking to context
        if (stepData.choices?.[0]?.message) {
          thinkingMessages.push(stepData.choices[0].message);
        }

        totalPromptTokens += stepData.usage?.prompt_tokens || 0;
        totalCompletionTokens += stepData.usage?.completion_tokens || 0;
      }

      // Final answer step
      const finalPrompt = {
        role: "system",
        content: "Based on your thinking above, now provide your final answer."
      };
      const finalMessages = [...thinkingMessages, finalPrompt];

      const finalApiResponse = await makeApiCall({
        model: actualModel,
        messages: finalMessages,
        temperature,
        max_tokens: maxTokens,
        seed,
      });

      if (!finalApiResponse.ok) {
        const errorText = await finalApiResponse.text();
        console.error(`${provider} API error in final step:`, finalApiResponse.status, errorText);
        return new Response(JSON.stringify({ 
          error: `${provider} API error in final step`,
          details: errorText 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: finalApiResponse.status,
        });
      }

      finalResponse = await finalApiResponse.json();
      totalPromptTokens += finalResponse.usage?.prompt_tokens || 0;
      totalCompletionTokens += finalResponse.usage?.completion_tokens || 0;
    }

    // Include actual selected model for debugging (unmasked)
    // The requested model alias is preserved in a separate field
    finalResponse.requested_model = model;
    finalResponse.actual_model = actualModel;
    finalResponse.pool_name = selection.poolName;
    finalResponse.pool_size = selection.poolSize;

    // Calculate cost
    const costCents = calculateCost(totalPromptTokens, totalCompletionTokens, actualModel);

    // Log usage
    await logUsage(supabase, authInfo.apiKeyId, authInfo.userId, { 
      model, 
      messages, 
      temperature,
      max_tokens: maxTokens,
      seed,
      tools,
      tool_choice,
      cot_steps: cotSteps 
    }, finalResponse, costCents, cotSteps);

    // Return response
    return new Response(JSON.stringify(finalResponse), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    console.error('Rose completions endpoint error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      details: errorMessage 
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});

