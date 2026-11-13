/** Compatibility entrypoint for Granola cron registration. */
import { scheduleMeetingSync } from './meetingCron';
import { runGranolaSyncJob } from './granolaSync';
export function scheduleGranolaSync(): void {
  scheduleMeetingSync('granola', runGranolaSyncJob);
}
