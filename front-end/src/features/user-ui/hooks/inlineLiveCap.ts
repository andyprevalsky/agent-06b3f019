/**
 * Live-iframe budget for inline trajectory views.
 *
 * Views near the viewport request a lease; at most `cap` hold one at a time and
 * the rest wait in request order (rendering their poster/summary). Releasing a
 * lease promotes the oldest waiter. Cost is O(cap) live frames no matter how
 * long the trajectory gets.
 */
import { useEffect, useSyncExternalStore } from 'react';

import { INLINE_VIEW_LIVE_CAP } from '../config';

export class InlineLiveCapStore {
  private readonly live = new Set<string>();
  private waiting: string[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(readonly cap: number = INLINE_VIEW_LIVE_CAP) {}

  request(id: string): void {
    if (this.live.has(id) || this.waiting.includes(id)) return;
    if (this.live.size < this.cap) this.live.add(id);
    else this.waiting.push(id);
    this.emit();
  }

  release(id: string): void {
    const wasLive = this.live.delete(id);
    const waitingBefore = this.waiting.length;
    this.waiting = this.waiting.filter((waitingId) => waitingId !== id);
    if (!wasLive && waitingBefore === this.waiting.length) return;
    while (this.live.size < this.cap && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next !== undefined) this.live.add(next);
    }
    this.emit();
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  liveCount(): number {
    return this.live.size;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Hold a live lease while `wantsLive`; returns whether this view may mount. */
export function useInlineLiveLease(store: InlineLiveCapStore, id: string, wantsLive: boolean) {
  const isLive = useSyncExternalStore(
    store.subscribe,
    () => store.isLive(id),
    () => false,
  );
  useEffect(() => {
    if (!wantsLive) return;
    store.request(id);
    return () => store.release(id);
  }, [store, id, wantsLive]);
  return isLive;
}
