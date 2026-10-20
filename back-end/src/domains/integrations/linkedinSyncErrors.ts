/** Errors of the LinkedIn sync routes (mapped to HTTP by routes.linkedin). */

import type { LinkedInPhase } from './linkedinSyncContract';

/** 409: another live export agent already owns that account's run. */
export class LinkedInSyncAlreadyRunningError extends Error {
  constructor(public readonly agentId: string) {
    super(`LinkedIn sync already running with agent ${agentId}`);
    this.name = 'LinkedInSyncAlreadyRunningError';
  }
}

/** 404: the agent named on POST /linkedin/sync does not exist for this user. */
export class LinkedInSyncAgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} not found`);
    this.name = 'LinkedInSyncAgentNotFoundError';
  }
}

/** 404: no LinkedIn run of this user belongs to the reporting agent (or none is running). */
export class LinkedInSyncNotFoundError extends Error {
  constructor(agentId: string | null) {
    super(
      agentId === null
        ? 'No LinkedIn export sync is running'
        : `No LinkedIn sync is recorded for agent ${agentId}`
    );
    this.name = 'LinkedInSyncNotFoundError';
  }
}

/** 400: several export runs are live and the report names neither its agent nor an account. */
export class LinkedInRunRequiredError extends Error {
  constructor(readonly accounts: string[]) {
    super(
      `Several LinkedIn exports are running; send agent_id or account_id (${accounts.join(', ')})`
    );
    this.name = 'LinkedInRunRequiredError';
  }
}

export type LinkedInPhaseErrorCode = 'PHASE_OUT_OF_ORDER' | 'SYNC_FINISHED' | 'UPLOAD_IN_PROGRESS';

/** 409: the report does not follow the run's current phase. */
export class LinkedInPhaseError extends Error {
  constructor(
    public readonly code: LinkedInPhaseErrorCode,
    public readonly current: LinkedInPhase
  ) {
    super(`LinkedIn sync is at ${current}; that report is not accepted (${code})`);
    this.name = 'LinkedInPhaseError';
  }
}
