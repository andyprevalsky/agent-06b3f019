import OpenAI from 'openai';

if (!process.env.OPENAI_API_KEY) {
  throw new Error('Missing OPENAI_API_KEY environment variable');
}

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function formatLLMJudgePrompt(text: string): Promise<string> {
  const systemPrompt = `You are an expert at formatting LLM judge prompts. Your task is to take a user's prompt and ensure it adheres to best practices for LLM judges that return scores from 0 to 1.

Best practices:
1. The prompt should clearly instruct the judge to return a float between 0 and 1
2. It should define what 0 means (failure/worst) and what 1 means (success/best)
3. It should be specific about evaluation criteria
4. It should request ONLY the numeric score, no explanation (unless explicitly needed)
5. It should be clear and unambiguous

Return ONLY the improved prompt text, nothing else.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Please format this LLM judge prompt:\n\n${text}`,
      },
    ],
    temperature: 0.3,
  });

  return completion.choices[0].message.content || text;
}

