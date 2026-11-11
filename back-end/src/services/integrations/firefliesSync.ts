/** Fireflies uses the same OAuth state, leases, cursor and document pipeline as Granola. */
import * as mcp from './firefliesMcp';
import { createMeetingSync } from './meetingSync';
export { MeetingSignInError as FirefliesSignInError } from './meetingSync';
export type {
  MeetingSyncOptions as FirefliesSyncOptions,
  MeetingSyncResult as FirefliesSyncResult,
} from './meetingSync';
const sync = createMeetingSync({
  id: 'fireflies',
  label: 'Fireflies',
  ...mcp,
  openSession: mcp.FirefliesSession.open.bind(mcp.FirefliesSession),
  isAuthError: (error: unknown) => error instanceof mcp.FirefliesMcpError && error.reconnect,
});
export const startFirefliesSignIn = sync.startSignIn;
export const completeFirefliesSignIn = sync.completeSignIn;
export const disconnectFireflies = sync.disconnect;
export const getFirefliesStatus = sync.getStatus;
export const syncFirefliesUser = sync.syncUser;
export const runFirefliesSyncJob = sync.runSyncJob;
