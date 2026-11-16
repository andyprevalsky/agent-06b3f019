import { userArchiveRoot } from '../../providers/llmArchiveRecord';
import { generateLLMJudgePrompt } from '../../providers/openrouter';

/** Generated before the agent exists: archived under the caller's `user-<userId>` root. */
export async function generatePrompt(goal: string, userId?: string | null): Promise<string> {
  const root = typeof userId === 'string' && userId !== '' ? userArchiveRoot(userId) : null;
  return generateLLMJudgePrompt(
    goal,
    root === null ? null : { agent_id: root, root_agent_id: root }
  );
}
