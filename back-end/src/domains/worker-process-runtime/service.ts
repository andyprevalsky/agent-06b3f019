import { getWorkerProcessRuntimeEnvelope } from './repo';
import type { WorkerRuntimeIssuer } from './types';

export const issueWorkerProcessRuntime: WorkerRuntimeIssuer = getWorkerProcessRuntimeEnvelope;
