import { startRealTimeSync, stopRealTimeSync, sync } from './service';
import type { SourceSyncSummary, UserDataSource } from './types';

export class UserDataSync {
  static sync(connected?: Set<string>): Promise<SourceSyncSummary[]> {
    return sync(connected);
  }

  static syncSource(source: UserDataSource): Promise<SourceSyncSummary[]> {
    return sync(new Set([source]), true);
  }

  static startRealTimeSync(connected?: Set<string>): Promise<void> {
    return startRealTimeSync(connected);
  }

  static stopRealTimeSync(): void {
    stopRealTimeSync();
  }
}
