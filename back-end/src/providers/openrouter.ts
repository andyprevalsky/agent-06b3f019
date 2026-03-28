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

export async function generateLLMJudgePrompt(goal: string): Promise<string> {
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

  const completion = await openrouter.chat.completions.create({
    model: 'openai/gpt-4.1', // OpenRouter format: provider/model
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Generate a STRICT LLM judge prompt for a super-intelligent autonomous agent system with this goal:\n\n${goal}`,
      },
    ],
    temperature: 0.3,
  });

  return (
    completion.choices[0].message.content ||
    'Return a score from 0 to 1 indicating how well the goal was achieved. Be EXTREMELY STRICT - only give 1.0 if the goal is COMPLETELY accomplished with verifiable results. This is a super-intelligent system that can solve any problem with enough effort.'
  );
}
