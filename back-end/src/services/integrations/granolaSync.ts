/** Granola compatibility API over the shared meeting sync pipeline. */
import * as mcp from './granolaMcp';
import { createMeetingSync } from './meetingSync';
export {
  MeetingSignInError as GranolaSignInError,
  MEETING_SYNC_INTERVAL_MS as GRANOLA_SYNC_INTERVAL_MS,
  BACKFILL_DAYS,
} from './meetingSync';
export type {
  MeetingSyncOptions as GranolaSyncOptions,
  MeetingSyncResult as GranolaSyncResult,
} from './meetingSync';
const sync = createMeetingSync({
  id: 'granola',
  label: 'Granola',
  ...mcp,
  openSession: mcp.GranolaSession.open.bind(mcp.GranolaSession),
  isAuthError: (error: unknown) => error instanceof mcp.GranolaMcpError && error.reconnect,
});
export const startGranolaSignIn = sync.startSignIn;
export const completeGranolaSignIn = sync.completeSignIn;
export const disconnectGranola = sync.disconnect;
export const getGranolaStatus = sync.getStatus;
export const syncGranolaUser = sync.syncUser;
export const runGranolaSyncJob = sync.runSyncJob;
