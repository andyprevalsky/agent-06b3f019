import OpenAI from 'openai';

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error('Missing OPENROUTER_API_KEY environment variable');
}

export const openrouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

export async function generateLLMJudgePrompt(goal: string): Promise<string> {
  const systemPrompt = `You are an expert at creating LLM judge prompts. Your task is to generate a judge prompt based on an agent's goal that adheres to best practices for LLM judges that return scores from 0 to 1.

Best practices:
1. The prompt should clearly instruct the judge to return a float between 0 and 1
2. It should define what 0 means (failure/worst) and what 1 means (success/best)
3. It should be specific about evaluation criteria based on the goal
4. It should request ONLY the numeric score, no explanation
5. It should be clear and unambiguous
6. It should evaluate whether the goal was achieved

Return ONLY the judge prompt text, nothing else.`;

  const completion = await openrouter.chat.completions.create({
    model: 'openai/gpt-4.1',  // OpenRouter format: provider/model
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Generate an LLM judge prompt for an agent with this goal:\n\n${goal}`,
      },
    ],
    temperature: 0.3,
  });

  return completion.choices[0].message.content || 'Return a score from 0 to 1 indicating how well the goal was achieved.';
}

