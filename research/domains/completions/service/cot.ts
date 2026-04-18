/**
 * Non-streaming chain-of-thought sub-flow.
 *
 * When the caller uses a non-streaming completion with `cot_steps > 1`, we run
 * N-1 "thinking" steps followed by a final answer step, carrying the model's
 * reasoning forward in the message list. When `cot_steps === 1`, we issue a
 * single direct completion — same dispatcher, one call.
 *
 * The sub-flow picks a provider (Cerebras vs OpenRouter) based on the
 * selected model, handles the Cerebras-specific schema transform, and returns
 * either the aggregated response JSON (for the caller to annotate + log) or a
 * 4xx/5xx `Response` on provider error.
 */

// deno-lint-ignore-file no-explicit-any

import { slog } from '../../../providers/logger.ts';
import {
  CEREBRAS_API_URL,
  corsHeaders,
  getCerebrasApiKey,
  getOpenRouterApiKey,
} from '../config.ts';
import { truncateForLogging } from '../utils.ts';
import { transformSchemaForCerebras } from './streaming.ts';
import { getMessagesForModel } from './vision.ts';

export interface CotParams {
  actualModel: string;
  isCerebras: boolean;
  messages: any[];
  temperature: number | undefined;
  maxTokens: number | undefined;
  seed: number | undefined;
  tools: any;
  tool_choice: any;
  response_format: any;
  otherParams: Record<string, any>;
  cotSteps: number;
  supabaseUrl: string;
}

export interface CotResult {
  /** Success: aggregated response JSON + token totals for the caller to annotate and log. */
  finalResponse?: any;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  /** Error: a ready-to-send Response the caller should return as-is. */
  errorResponse?: Response;
}

/**
 * Run a single-step or multi-step non-streaming completion. Returns either
 * `{ finalResponse, totalPromptTokens, totalCompletionTokens }` on success
 * or `{ errorResponse }` if the upstream provider returned an error.
 */
export async function runCompletionOrCot(params: CotParams): Promise<CotResult> {
  const {
    actualModel,
    isCerebras,
    messages,
    temperature,
    maxTokens,
    seed,
    tools,
    tool_choice,
    response_format,
    otherParams,
    cotSteps,
    supabaseUrl,
  } = params;

  const makeApiCall = makeApiCallFactory(actualModel, isCerebras, supabaseUrl);

  if (cotSteps === 1) {
    return await runSingleStep({
      actualModel,
      isCerebras,
      messages,
      temperature,
      maxTokens,
      seed,
      tools,
      tool_choice,
      response_format,
      otherParams,
      makeApiCall,
    });
  }
  return await runMultiStepCot({
    actualModel,
    isCerebras,
    messages,
    temperature,
    maxTokens,
    seed,
    cotSteps,
    makeApiCall,
  });
}

type MakeApiCall = (body: any) => Promise<globalThis.Response>;

/**
 * Build the provider-aware fetch closure. Cerebras is OpenAI-compatible but
 * requires a distinct schema shape (additionalProperties, response_format
 * envelope, dropped `parallel_tool_calls`); OpenRouter accepts the body as-is.
 */
function makeApiCallFactory(
  actualModel: string,
  isCerebras: boolean,
  supabaseUrl: string,
): MakeApiCall {
  return async (body: any): Promise<globalThis.Response> => {
    if (isCerebras) {
      slog('info', `Calling Cerebras API with model: ${actualModel}`);

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
        if (
          body.response_format.type === 'json_schema' && body.response_format.json_schema?.schema
        ) {
          const transformedSchema = transformSchemaForCerebras(
            body.response_format.json_schema.schema,
          );
          cerebrasBody.response_format = {
            type: 'json_schema',
            json_schema: {
              name: body.response_format.json_schema.name || 'response',
              strict: true,
              schema: transformedSchema,
            },
          };
        } else {
          cerebrasBody.response_format = body.response_format;
        }
      }

      slog('info', `Cerebras request body:`, {
        data: JSON.stringify(truncateForLogging(cerebrasBody), null, 2),
      });

      return await fetch(CEREBRAS_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getCerebrasApiKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(cerebrasBody),
      });
    }
    return await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getOpenRouterApiKey()}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': supabaseUrl,
        'X-Title': 'Rose Benchmark Suite',
      },
      body: JSON.stringify(body),
    });
  };
}

interface SingleStepArgs {
  actualModel: string;
  isCerebras: boolean;
  messages: any[];
  temperature: number | undefined;
  maxTokens: number | undefined;
  seed: number | undefined;
  tools: any;
  tool_choice: any;
  response_format: any;
  otherParams: Record<string, any>;
  makeApiCall: MakeApiCall;
}

async function runSingleStep(args: SingleStepArgs): Promise<CotResult> {
  const {
    actualModel,
    isCerebras,
    messages,
    temperature,
    maxTokens,
    seed,
    tools,
    tool_choice,
    response_format,
    otherParams,
    makeApiCall,
  } = args;

  // Transform messages for vision models (handles __screenshot_base64__)
  const modelMessages = getMessagesForModel(messages, actualModel);

  const requestBody: any = {
    model: actualModel,
    messages: modelMessages,
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
    slog('error', `${provider} API error:`, { data: [apiResponse.status, errorText] });
    slog('error', `Request body was:`, { data: JSON.stringify(requestBody, null, 2) });

    // Try to parse error for more details
    let errorDetails = errorText;
    try {
      const errorJson = JSON.parse(errorText);
      errorDetails = JSON.stringify(errorJson, null, 2);
      slog('error', `${provider} error details:`, { data: errorJson });
    } catch (_e) {
      // errorText is not JSON, keep as-is
    }

    return {
      errorResponse: new Response(
        JSON.stringify({
          error: `${provider} API error`,
          status: apiResponse.status,
          details: errorDetails,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: apiResponse.status,
        },
      ),
    };
  }

  const finalResponse = await apiResponse.json();
  return {
    finalResponse,
    totalPromptTokens: finalResponse.usage?.prompt_tokens || 0,
    totalCompletionTokens: finalResponse.usage?.completion_tokens || 0,
  };
}

interface MultiStepArgs {
  actualModel: string;
  isCerebras: boolean;
  messages: any[];
  temperature: number | undefined;
  maxTokens: number | undefined;
  seed: number | undefined;
  cotSteps: number;
  makeApiCall: MakeApiCall;
}

async function runMultiStepCot(args: MultiStepArgs): Promise<CotResult> {
  const { actualModel, isCerebras, messages, temperature, maxTokens, seed, cotSteps, makeApiCall } =
    args;

  // Transform messages for vision models (handles __screenshot_base64__)
  const modelMessages = getMessagesForModel(messages, actualModel);
  const thinkingMessages = [...modelMessages];
  const provider = isCerebras ? 'Cerebras' : 'OpenRouter';
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  // Thinking steps (N-1 steps)
  for (let i = 0; i < cotSteps - 1; i++) {
    const thinkingPrompt = {
      role: 'system',
      content: `Think step by step. You have ${
        cotSteps - 1
      } thinking steps before giving your final answer. This is thinking step ${
        i + 1
      }. Show your reasoning.`,
    };

    const stepMessages = [...thinkingMessages, thinkingPrompt];

    // deno-lint-ignore no-await-in-loop -- CoT steps are sequential: each step feeds the next
    const stepResponse = await makeApiCall({
      model: actualModel,
      messages: stepMessages,
      temperature,
      max_tokens: maxTokens,
      seed,
    });

    if (!stepResponse.ok) {
      // deno-lint-ignore no-await-in-loop -- error path reads body before returning
      const errorText = await stepResponse.text();
      slog('error', `${provider} API error in CoT step:`, {
        data: [stepResponse.status, errorText],
      });
      return {
        errorResponse: new Response(
          JSON.stringify({
            error: `${provider} API error in CoT step`,
            details: errorText,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: stepResponse.status,
          },
        ),
      };
    }

    // deno-lint-ignore no-await-in-loop -- CoT steps are sequential; json() per step
    const stepData = await stepResponse.json();

    // Add assistant's thinking to context
    if (stepData.choices?.[0]?.message) {
      thinkingMessages.push(stepData.choices[0].message);
    }

    totalPromptTokens += stepData.usage?.prompt_tokens || 0;
    totalCompletionTokens += stepData.usage?.completion_tokens || 0;
  }

  // Final answer step
  const finalPrompt = {
    role: 'system',
    content: 'Based on your thinking above, now provide your final answer.',
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
    slog('error', `${provider} API error in final step:`, {
      data: [finalApiResponse.status, errorText],
    });
    return {
      errorResponse: new Response(
        JSON.stringify({
          error: `${provider} API error in final step`,
          details: errorText,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: finalApiResponse.status,
        },
      ),
    };
  }

  const finalResponse = await finalApiResponse.json();
  totalPromptTokens += finalResponse.usage?.prompt_tokens || 0;
  totalCompletionTokens += finalResponse.usage?.completion_tokens || 0;
  return { finalResponse, totalPromptTokens, totalCompletionTokens };
}
