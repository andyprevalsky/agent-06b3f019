import { scheduleMeetingSync } from './meetingCron';
import { runFirefliesSyncJob } from './firefliesSync';
export function scheduleFirefliesSync(): void {
  scheduleMeetingSync('fireflies', runFirefliesSyncJob);
}
