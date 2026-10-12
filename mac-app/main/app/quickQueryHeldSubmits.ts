import { randomUUID } from 'crypto';
import type { QuickQueryHeldSubmit, QuickQueryPayload } from '../../shared/types/ipc';

/**
 * Submits wait in the main process until the main window's consumer claims
 * them. Only a main window that never becomes ready can reach this bound.
 */
export const QUICK_QUERY_MAX_PENDING_SUBMITS = 20;

/**
 * Launcher submits the main window has not claimed yet. A submit stays listed
 * until it is claimed, so a renderer that reloads or closes first loses
 * nothing; it can be claimed once, so only one consumer ever launches it.
 */
export class HeldQuickQuerySubmits {
  private held: QuickQueryHeldSubmit[] = [];

  get size(): number {
    return this.held.length;
  }

  add(payload: QuickQueryPayload): void {
    this.held.push({ id: randomUUID(), payload });
    if (this.held.length > QUICK_QUERY_MAX_PENDING_SUBMITS) {
      this.held.shift();
      console.error('[QuickQuery] Oldest held submit dropped - main window never took it');
    }
  }

  list(): QuickQueryHeldSubmit[] {
    return [...this.held];
  }

  claim(id: unknown): boolean {
    const index = this.held.findIndex((entry) => entry.id === id);
    if (index === -1) return false;

    this.held.splice(index, 1);
    return true;
  }
}
