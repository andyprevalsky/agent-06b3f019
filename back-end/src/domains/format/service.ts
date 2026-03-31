import { generateLLMJudgePrompt } from '../../providers/openrouter';

export async function generatePrompt(goal: string): Promise<string> {
  return generateLLMJudgePrompt(goal);
}
