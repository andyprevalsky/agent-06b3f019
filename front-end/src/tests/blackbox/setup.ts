/**
 * Blackbox test setup file — loaded by vitest before each test file.
 * Configures MSW server, capture, and jest-dom matchers.
 */
import { beforeAll, afterEach, afterAll } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { server } from './msw/server';
import { clearCaptures, installCapture } from './msw/capture';

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
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: testLocalStorage,
});
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: testLocalStorage,
});

// Mock window.matchMedia (not available in jsdom)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Mock IntersectionObserver (not available in jsdom)
class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  value: MockIntersectionObserver,
});

// Mock ResizeObserver (not available in jsdom)
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  value: MockResizeObserver,
});

// Mock visualViewport (not available in jsdom, needed for shader components)
if (!globalThis.visualViewport) {
  (globalThis as Record<string, unknown>).visualViewport = {
    width: 1024,
    height: 768,
    offsetLeft: 0,
    offsetTop: 0,
    pageLeft: 0,
    pageTop: 0,
    scale: 1,
    onresize: null,
    onscroll: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  };
}

// Mock HTMLMediaElement methods (not available in jsdom)
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};
HTMLMediaElement.prototype.load = () => {};

// Mock WebGL context (not available in jsdom, needed for shader components)
// Uses a Proxy to auto-stub any missing method calls
HTMLCanvasElement.prototype.getContext = ((origGetContext) => {
  return function (this: HTMLCanvasElement, contextId: string, ...args: unknown[]) {
    if (contextId === 'webgl' || contextId === 'webgl2' || contextId === 'experimental-webgl') {
      const glStubs: Record<string, unknown> = {
        canvas: this,
        drawingBufferWidth: 300,
        drawingBufferHeight: 150,
        getShaderParameter: () => true,
        getProgramParameter: () => true,
        getAttribLocation: () => 0,
        getUniformLocation: () => ({}),
        getShaderInfoLog: () => '',
        getProgramInfoLog: () => '',
        getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
        getExtension: () => null,
        getParameter: () => 0,
        createShader: () => ({}),
        createProgram: () => ({}),
        createBuffer: () => ({}),
        createTexture: () => ({}),
        isContextLost: () => false,
      };
      return new Proxy(glStubs, {
        get(target, prop) {
          if (prop in target) return target[prop as string];
          // GL enum constants (VERTEX_SHADER, COMPILE_STATUS, etc.) are uppercase
          if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) return 0;
          return () => {};
        },
      });
    }
    return origGetContext.call(this, contextId, ...args);
  };
})(HTMLCanvasElement.prototype.getContext);

// Start MSW server before all tests
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  installCapture(server);
});

// Reset handlers and clear captures between tests
afterEach(() => {
  server.resetHandlers();
  clearCaptures();
});

// Clean up after all tests
afterAll(() => {
  server.close();
});
