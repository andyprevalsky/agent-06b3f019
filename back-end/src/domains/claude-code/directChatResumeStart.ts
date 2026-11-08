/**
 * The supervised start of a stopped code agent's resume (CodeAgentResumeWorkflow).
 * A deploy mid-way, whose live queue's workers do not register the resume type
 * yet, is a 409 with its reason ("Rose's workers are updating; send again
 * shortly"), never a run stranded on a queue that cannot run it.
 */
import {
  ResumeWorkersUpdatingError,
  startCodeAgentResumeWorkflow,
} from '../../providers/codeAgentResumeWorkflow';
import { DirectChatError } from './directChatRows';
import { withSerializedLock } from '../../providers/sharedState';

export async function startCodeAgentResumeWorkflowOrRefuse(
  request: Parameters<typeof startCodeAgentResumeWorkflow>[0]
): Promise<void> {
  try {
    await startCodeAgentResumeWorkflow(request);
  } catch (error) {
    if (!(error instanceof ResumeWorkersUpdatingError)) throw error;
    throw new DirectChatError(409, 'CODE_AGENT_WORKERS_UPDATING', error.message);
  }
}

/**
 * Run a resume's "already starting?" check and its marker claim under one lock
 * per spawn, so two quick turns to the same stopped code agent never both start
 * a run (the second queues behind the first instead of failing busy).
 */
export function claimResumeStart<T>(key: string, claim: () => Promise<T>): Promise<T> {
  return withSerializedLock(`code-agent-resume:start:${key}`, claim);
}
