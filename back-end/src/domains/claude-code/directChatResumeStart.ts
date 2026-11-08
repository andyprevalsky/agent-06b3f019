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
