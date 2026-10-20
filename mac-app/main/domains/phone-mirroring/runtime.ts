/**
 * Runtime layer for phone-mirroring.
 *
 * `PhoneMirroring.start()` runs one background loop (started and stopped by
 * SyncManager, so it follows sign-in, sign-out and impersonation):
 *
 *   ┌─► presence cycle ── signed out / not connected ──► sleep 20s ──┐
 *   │        │ registered (connected)                                │
 *   │        ▼                                                       │
 *   │   viewer demand? ── no ──► long-poll ≤20s ── still no ─────────┤
 *   │        │ yes                       │ yes                       │
 *   │        ▼                           ▼                           │
 *   │   stream frames (≤ maxFps) until the viewer leaves ────────────┘
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Each loop iteration is at least PRESENCE_INTERVAL_MS apart unless a viewer
 * is waiting, so a backend that answers the long-poll early cannot make the
 * Mac spin. `stop()` aborts the long-poll and wakes any sleep immediately.
 */

import { logConsole, logConsoleError } from '../../base/logger';
import { DEMAND_WAIT_MS, ERROR_BACKOFF_MS, LOG_COMPONENT, PRESENCE_INTERVAL_MS } from './config';
import * as service from './service';
import type { MirroringStatus } from './types';

export type { MirroringStatus } from './types';

export class PhoneMirroring {
  private static running = false;
  private static generation = 0;
  private static abortController: AbortController | null = null;
  private static wakeSleep: (() => void) | null = null;

  /** Start the presence/relay loop (no-op off macOS 15+ or if already running). */
  static start(): boolean {
    if (this.running) return true;
    if (!service.platformSupported()) {
      logConsole(LOG_COMPONENT, 'iPhone Mirroring needs macOS 15 or later; not starting');
      return false;
    }
    this.running = true;
    const generation = ++this.generation;
    logConsole(LOG_COMPONENT, 'Starting phone presence loop');
    void this.loop(generation).catch((error) =>
      logConsoleError(LOG_COMPONENT, 'phone presence loop crashed', error)
    );
    return true;
  }

  /** Stop the loop; any in-flight long-poll is aborted. */
  static stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    this.abortController?.abort();
    this.abortController = null;
    this.wakeSleep?.();
    this.wakeSleep = null;
    service.resetPresenceState();
    logConsole(LOG_COMPONENT, 'Stopped phone presence loop');
  }

  static isActive(): boolean {
    return this.running;
  }

  /** Current iPhone Mirroring status (for diagnostics / a future settings UI). */
  static async status(): Promise<MirroringStatus> {
    return service.detectMirroring();
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeSleep = done;
    });
  }

  private static async loop(generation: number): Promise<void> {
    const active = () => this.running && generation === this.generation;
    while (active()) {
      const cycleStart = Date.now();
      const outcome = await service.runPresenceCycle();
      if (!active()) break;
      if (outcome.kind !== 'registered') {
        await this.sleep(outcome.kind === 'error' ? ERROR_BACKOFF_MS : PRESENCE_INTERVAL_MS);
        continue;
      }
      let demand = outcome.stream;
      if (!demand.requested) {
        this.abortController = new AbortController();
        const waited = await service.waitForViewer(
          outcome.phoneId,
          DEMAND_WAIT_MS,
          this.abortController.signal
        );
        this.abortController = null;
        if (!active()) break;
        if (waited === null) {
          await this.sleep(ERROR_BACKOFF_MS);
          continue;
        }
        demand = waited;
      }
      if (demand.requested) {
        await service.streamWhileRequested(outcome.phoneId, demand, {
          isActive: active,
          sleep: (ms) => this.sleep(ms),
          now: () => Date.now(),
        });
        continue;
      }
      const remaining = PRESENCE_INTERVAL_MS - (Date.now() - cycleStart);
      if (remaining > 0 && active()) await this.sleep(remaining);
    }
  }
}
