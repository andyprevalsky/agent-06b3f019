/**
 * Blackbox test setup file — loaded by vitest before each test file.
 * Configures MSW server, capture, and jest-dom matchers.
 */
import { beforeAll, afterEach, afterAll } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/dom';
import { server } from './msw/server';
import { clearCaptures, installCapture } from './msw/capture';

// Allow async UI transitions to settle under full coverage instrumentation,
// while retaining a finite deadline for missing elements and stuck effects.
configure({ asyncUtilTimeout: 5_000 });

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

class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = MockWebSocket.CONNECTING;
  readonly OPEN = MockWebSocket.OPEN;
  readonly CLOSING = MockWebSocket.CLOSING;
  readonly CLOSED = MockWebSocket.CLOSED;

  binaryType: BinaryType = 'blob';
  bufferedAmount = 0;
  extensions = '';
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  protocol = '';
  readyState = MockWebSocket.CONNECTING;

  constructor(
    readonly url: string | URL,
    protocols?: string | string[],
  ) {
    super();
    if (Array.isArray(protocols)) this.protocol = protocols[0] ?? '';
    else this.protocol = protocols ?? '';
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      const event = new Event('open');
      this.onopen?.(event);
      this.dispatchEvent(event);
    }, 0);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    const event = new CloseEvent('close');
    this.onclose?.(event);
    this.dispatchEvent(event);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data !== 'string') return;

    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || frame.length !== 5) return;

    const [joinRef, ref, topic, event] = frame as [
      string | null,
      string | null,
      string,
      string,
      unknown,
    ];
    if (
      (event !== 'phx_join' &&
        event !== 'phx_leave' &&
        event !== 'heartbeat' &&
        event !== 'access_token') ||
      ref === null
    ) {
      return;
    }

    const reply = JSON.stringify([
      joinRef,
      ref,
      topic,
      'phx_reply',
      { status: 'ok', response: {} },
    ]);
    setTimeout(() => {
      if (this.readyState !== MockWebSocket.OPEN) return;
      const message = new MessageEvent('message', { data: reply });
      this.onmessage?.(message);
      this.dispatchEvent(message);
    }, 0);
  }
}

Object.defineProperty(window, 'WebSocket', {
  configurable: true,
  writable: true,
  value: MockWebSocket,
});
Object.defineProperty(globalThis, 'WebSocket', {
  configurable: true,
  writable: true,
  value: MockWebSocket,
});

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
