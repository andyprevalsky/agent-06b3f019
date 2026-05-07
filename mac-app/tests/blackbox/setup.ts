import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './msw/server';
import { clearCaptures } from './msw/capture';

class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

const testLocalStorage = new MemoryStorage();

/**
 * Node 25 exposes an experimental `globalThis.localStorage` object when the
 * process is launched with `--localstorage-file`, but in this test runtime it
 * is missing the Web Storage methods. Renderer tests and a few imported
 * browser-oriented dependencies expect the jsdom implementation instead.
 */
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: testLocalStorage,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: testLocalStorage,
  });
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  clearCaptures();
});

afterAll(() => {
  server.close();
});
