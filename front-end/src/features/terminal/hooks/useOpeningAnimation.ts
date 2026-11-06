/**
 * Terminal feature — opening animation hook.
 *
 * Manages the reveal-pause-fade cycle for opening messages
 * displayed when no agent is selected.
 *
 * STATE MACHINE (per message, OPENING_MESSAGES order):
 *   [REVEALING] --+2% every 20ms--> revealProgress 100
 *       |-- last message --> [TYPING_COMPLETE] (stays visible)
 *       v
 *   [PAUSED] --message pause--> [FADING] --300ms--> next message [REVEALING]
 * Runs only while no agent is selected and the network is not loading;
 * otherwise the cycle holds where it is.
 *
 * The state lives in a store owned by the chat column (so it survives the
 * column's own re-renders and agent switches) and only the caption subscribes
 * to it: a 20ms reveal tick re-renders the caption, not the column, composer
 * and loader around it.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { OPENING_MESSAGES } from '../config';
import type { AnimationPhase } from '../types';

const REVEAL_TICK_MS = 20;
const REVEAL_STEP = 2;
const FADE_MS = 300;

export interface OpeningAnimationState {
  currentMessageIndex: number;
  animationPhase: AnimationPhase;
  revealProgress: number;
  isTypingComplete: boolean;
}

export interface OpeningAnimationStore {
  getSnapshot: () => OpeningAnimationState;
  subscribe: (listener: () => void) => () => void;
  /** Runs (true) or holds (false) the cycle. */
  setRunning: (running: boolean) => void;
  reset: () => void;
}

const INITIAL_STATE: OpeningAnimationState = {
  currentMessageIndex: 0,
  animationPhase: 'revealing',
  revealProgress: 0,
  isTypingComplete: false,
};

export function createOpeningAnimationStore(): OpeningAnimationStore {
  let state = INITIAL_STATE;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const set = (next: Partial<OpeningAnimationState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const after = (ms: number, apply: () => void) => {
    timer = setTimeout(() => {
      timer = null;
      apply();
      step();
    }, ms);
  };

  /** Schedules the next transition from the current state (one timer at a time). */
  function step() {
    clear();
    if (!running || state.isTypingComplete) return;

    const { currentMessageIndex, animationPhase, revealProgress } = state;
    if (currentMessageIndex >= OPENING_MESSAGES.length) {
      set({ isTypingComplete: true });
      return;
    }

    if (animationPhase === 'revealing') {
      if (revealProgress < 100) {
        after(REVEAL_TICK_MS, () =>
          set({ revealProgress: Math.min(100, state.revealProgress + REVEAL_STEP) }),
        );
        return;
      }
      if (currentMessageIndex === OPENING_MESSAGES.length - 1) {
        set({ isTypingComplete: true });
        return;
      }
      set({ animationPhase: 'paused' });
      step();
      return;
    }

    if (animationPhase === 'paused') {
      const [, pauseDuration] = OPENING_MESSAGES[currentMessageIndex];
      after(pauseDuration, () => set({ animationPhase: 'fading' }));
      return;
    }

    after(FADE_MS, () =>
      set({
        currentMessageIndex: state.currentMessageIndex + 1,
        animationPhase: 'revealing',
        revealProgress: 0,
      }),
    );
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setRunning: (next) => {
      running = next;
      if (running) step();
      else clear();
    },
    reset: () => {
      set(INITIAL_STATE);
      step();
    },
  };
}

/** Owns the opening cycle; the returned store is stable for the component's life. */
export function useOpeningAnimation(
  selectedAgentId: string | null,
  isLoadingNetwork: boolean,
): OpeningAnimationStore {
  const [store] = useState(createOpeningAnimationStore);
  const running = !selectedAgentId && !isLoadingNetwork;

  useEffect(() => {
    store.setRunning(running);
    return () => store.setRunning(false);
  }, [store, running]);

  return store;
}

/** Subscribes a caption to the opening cycle. */
export function useOpeningAnimationState(store: OpeningAnimationStore): OpeningAnimationState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
