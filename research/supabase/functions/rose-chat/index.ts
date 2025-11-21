import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};

// Model pools for Rose variants
const MODEL_POOLS = {
  'rose-ultra': [
    'anthropic/claude-sonnet-4.5',
    'openai/gpt-5'
  ],
  'rose-1-fast': [
    'moonshotai/kimi-k2-thinking',
    'anthropic/claude-sonnet-4.5',
    'deepseek/deepseek-chat-v3.1',
    'google/gemini-2.5-flash'
  ],
  'rose': [ //alias for rose-1-fast
    'moonshotai/kimi-k2-thinking',
    'anthropic/claude-sonnet-4.5',
    'deepseek/deepseek-chat-v3.1',
    'google/gemini-2.5-flash'
  ]
};

// Randomly select a model from the pool
function selectModel(requestedModel: string): string {
  let normalized = requestedModel.toLowerCase();
  if (normalized.startsWith('rose-labs/')) {
    normalized = normalized.replace('rose-labs/', '');
  }
  
  const pool = MODEL_POOLS[normalized as keyof typeof MODEL_POOLS];
  
  if (!pool) {
    throw new Error(`Unknown model: ${requestedModel}. Use 'rose-labs/rose-1-fast' or 'rose-labs/rose-1-ultra'`);
  }
  
  const selectedModel = pool[Math.floor(Math.random() * pool.length)];
  console.log(`🎲 Model selection: ${requestedModel} → ${selectedModel}`);
  return selectedModel;
}

// Validate API key and return user info
async function validateApiKey(apiKey: string, supabase: any): Promise<{ apiKeyId: string, userId: string } | null> {
  const { data, error } = await supabase
    .from('RoseApiKey')
    .select('id, userId')
    .eq('apiKey', apiKey)
    .single();
  
  if (error || !data) {
    console.error('API key validation failed:', error);
    return null;
  }
  
  return { apiKeyId: data.id, userId: data.userId };
}

// Calculate cost based on token usage
function calculateCost(promptTokens: number, completionTokens: number, model: string): number {
  // Simplified cost calculation - in production, fetch actual pricing
  // These are approximate costs per million tokens in cents
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
    const { model, messages, temperature, max_tokens, cot_steps } = await req.json();
    const cotSteps = cot_steps || 1;

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
    let actualModel: string;
    try {
      actualModel = selectModel(model);
    } catch (error) {
      return new Response(JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Invalid model' 
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    // Handle CoT steps
    let finalResponse: any;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    if (cotSteps === 1) {
      // Direct answer (no CoT)
      const openrouterBody = {
        model: actualModel,
        messages,
        temperature,
        max_tokens,
      };

      const openrouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('OPENROUTER_API_KEY')}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': supabaseUrl,
          'X-Title': 'Rose Benchmark Suite'
        },
        body: JSON.stringify(openrouterBody)
      });

      if (!openrouterResponse.ok) {
        const errorText = await openrouterResponse.text();
        console.error('OpenRouter API error:', openrouterResponse.status, errorText);
        return new Response(JSON.stringify({ 
          error: 'OpenRouter API error',
          details: errorText 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: openrouterResponse.status,
        });
      }

      finalResponse = await openrouterResponse.json();
      totalPromptTokens = finalResponse.usage?.prompt_tokens || 0;
      totalCompletionTokens = finalResponse.usage?.completion_tokens || 0;

    } else {
      // Multi-step CoT
      const thinkingMessages = [...messages];
      const intermediateResponses = [];

      // Thinking steps (N-1 steps)
      for (let i = 0; i < cotSteps - 1; i++) {
        const thinkingPrompt = {
          role: "system",
          content: `Think step by step. You have ${cotSteps - 1} thinking steps before giving your final answer. This is thinking step ${i + 1}. Show your reasoning.`
        };

        const stepMessages = [...thinkingMessages, thinkingPrompt];

        const stepResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('OPENROUTER_API_KEY')}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': supabaseUrl,
            'X-Title': 'Rose Benchmark Suite'
          },
          body: JSON.stringify({
            model: actualModel,
            messages: stepMessages,
            temperature,
            max_tokens,
          })
        });

        if (!stepResponse.ok) {
          const errorText = await stepResponse.text();
          console.error('OpenRouter API error in CoT step:', stepResponse.status, errorText);
          return new Response(JSON.stringify({ 
            error: 'OpenRouter API error in CoT step',
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

      const finalOpenrouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('OPENROUTER_API_KEY')}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': supabaseUrl,
          'X-Title': 'Rose Benchmark Suite'
        },
        body: JSON.stringify({
          model: actualModel,
          messages: finalMessages,
          temperature,
          max_tokens,
        })
      });

      if (!finalOpenrouterResponse.ok) {
        const errorText = await finalOpenrouterResponse.text();
        console.error('OpenRouter API error in final step:', finalOpenrouterResponse.status, errorText);
        return new Response(JSON.stringify({ 
          error: 'OpenRouter API error in final step',
          details: errorText 
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: finalOpenrouterResponse.status,
        });
      }

      finalResponse = await finalOpenrouterResponse.json();
      totalPromptTokens += finalResponse.usage?.prompt_tokens || 0;
      totalCompletionTokens += finalResponse.usage?.completion_tokens || 0;
    }

    // Mask the actual model in the response
    if (finalResponse.model) {
      finalResponse.model = model;
    }

    // Calculate cost
    const costCents = calculateCost(totalPromptTokens, totalCompletionTokens, actualModel);

    // Log usage
    await logUsage(supabase, authInfo.apiKeyId, authInfo.userId, { model, messages, cot_steps: cotSteps }, finalResponse, costCents, cotSteps);

    // Return response
    return new Response(JSON.stringify(finalResponse), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    console.error('Rose chat endpoint error:', error);
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

