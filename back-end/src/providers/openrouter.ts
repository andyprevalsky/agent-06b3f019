import { finishLlmCapture, startLlmCapture } from './llmDump';
import { simpleArchiveOutput, type ArchiveUsage } from './llmArchiveRecord';
import { createLogger } from './logger';
import OpenAI from 'openai';
import dotenv from 'dotenv';

// Ensure env vars are loaded before checking
dotenv.config();

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error('Missing OPENROUTER_API_KEY environment variable');
}

export const openrouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

// Use OpenAI directly for prompt generation (avoids OpenRouter credit dependency).
// Route through globalThis.fetch so blackbox-test fetchCapture can intercept.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  fetch: ((url: string | URL, init?: RequestInit) => globalThis.fetch(url, init)) as typeof fetch,
});

/**
 * `archive` binds the call to the caller's documented per-user root
 * (`user-<userId>`): the judge prompt is generated before the agent exists.
 */
export async function generateLLMJudgePrompt(
  goal: string,
  archive: { agent_id: string; root_agent_id: string } | null = null
): Promise<string> {
  const systemPrompt = `You are an expert at creating LLM judge prompts for evaluating a SUPER-INTELLIGENT AUTONOMOUS SYSTEM capable of solving ANY problem with enough persistence, creativity, and effort.

CRITICAL CONTEXT: You are generating a judge prompt for an AI agent system that:
- Has access to tools like web search, research, spawning sub-agents, and more
- Can coordinate complex multi-step tasks across parallel sub-agents
- Can ask the user for clarification when needed
- Should NEVER be considered "done" just because it's an AI or the task seems hard
- Can solve problems that require real-world action, creativity, and unlimited persistence

Your judge prompt MUST be EXTREMELY STRICT and should:
1. Clearly instruct the judge to return a float between 0.0 and 1.0
2. Define what 0.0 means (no progress/not started) and what 1.0 means (goal COMPLETELY achieved, not just "attempted" or "explained")
3. Be VERY specific about what constitutes actual completion vs. just planning or explanation
4. REJECT partial completions, explanations, or "I would do X" responses - only ACTUAL results count
5. Make it clear that the system is SUPER-INTELLIGENT and can solve the goal if given enough effort
6. Emphasize that 1.0 should ONLY be given when the goal is FULLY accomplished, not when the agent has "done what an AI can do"
7. Be unambiguous: the agent must produce REAL, CONCRETE, VERIFIABLE results

IMPORTANT: Do NOT make excuses for the AI. Do NOT accept "as an AI, I cannot..." as a valid completion. This system CAN solve the goal through persistence, creativity, tool use, and coordination.

Return ONLY the judge prompt text, nothing else.`;

  const fallback = `Return a score from 0 to 1 indicating how well this goal was achieved: "${goal}". Be EXTREMELY STRICT — only give 1.0 if the goal is COMPLETELY accomplished with verifiable results. The system is autonomous and can solve any problem with persistence, creativity, and tool use; do not accept "as an AI, I cannot…" as completion. 0.0 means no real progress; 1.0 means the goal is fully done with concrete, verifiable evidence.`;

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    {
      role: 'user' as const,
      content: `Generate a STRICT LLM judge prompt for a super-intelligent autonomous agent system with this goal:\n\n${goal}`,
    },
  ];
  const startedAtMs = Date.now();
  // Archiving is observer-only: a capture failure is logged and never fails the call.
  let capture: ReturnType<typeof startLlmCapture> | null = null;
  try {
    capture = startLlmCapture({
      call_site: 'llm_judge_prompt_generation',
      agent_id: archive?.agent_id,
      root_agent_id: archive?.root_agent_id,
      model: 'gpt-4.1',
      message_count: messages.length,
      messages,
      config: { provider: 'openai', model: 'gpt-4.1', temperature: 0.3 },
    });
  } catch (captureError) {
    log.warn('llm_judge_prompt.archive_start_failed', { error: String(captureError) });
  }
  const finish = (
    content: string,
    response: OpenAI.Chat.Completions.ChatCompletion | null,
    error?: unknown,
    returnedFallback = false
  ): void => {
    if (capture === null) return;
    try {
      finishLlmCapture(capture, {
        model: 'gpt-4.1',
        output: simpleArchiveOutput({
          content,
          actualModel: response?.model ?? 'gpt-4.1',
          provider: 'openai',
          startedAtMs,
          usage: judgePromptUsage(response),
          requestId: response?.id ?? null,
          structured: response ?? undefined,
          error,
        }),
        ...(returnedFallback ? { extra: { returned_fallback: true } } : {}),
      });
    } catch (captureError) {
      log.warn('llm_judge_prompt.archive_finish_failed', { error: String(captureError) });
    }
  };
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages,
      temperature: 0.3,
    });

    const generated = completion.choices[0].message.content;
    const content = generated || fallback;
    finish(content, completion, undefined, !generated);
    return content;
  } catch (error) {
    // Tests: when fastForward has no cached response and OpenAI rejects (quota,
    // missing key, etc.), fall back to a deterministic prompt so tests that
    // don't care about exact wording still pass. Scoped strictly to the
    // blackbox test backend.
    if (process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND === '1') {
      // The fallback is what the caller receives: keep it in the trajectory.
      finish(fallback, null, error, true);
      return fallback;
    }
    // A failed call still closes its start record (no orphaned start in the archive).
    finish('', null, error);
    throw error;
  }
}

const log = createLogger('LlmJudgePrompt');

/** OpenAI chat usage in the archive's normalized keys (reasoning tokens when reported). */
function judgePromptUsage(
  response: OpenAI.Chat.Completions.ChatCompletion | null
): Partial<ArchiveUsage> | undefined {
  const usage = response?.usage;
  if (usage === undefined) return undefined;
  return {
    prompt: usage.prompt_tokens,
    completion: usage.completion_tokens,
    total: usage.total_tokens,
    reasoning: usage.completion_tokens_details?.reasoning_tokens ?? null,
    finish_reason: response?.choices[0]?.finish_reason ?? null,
  };
}
