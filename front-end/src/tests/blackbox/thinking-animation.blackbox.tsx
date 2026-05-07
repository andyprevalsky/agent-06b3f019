import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThinkingAnimation from '@/components/ThinkingAnimation';

const frameData = {
  frames: [{ t: 0, xml: '<svg><g id="thinking-frame"></g></svg>' }],
};

describe('ThinkingAnimation asset loading', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(frameData), { status: 200 }));
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('loads the public animation asset from the app root', async () => {
    render(<ThinkingAnimation autoplay={false} loop={false} />);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/thinking_animations.txt');
      expect(document.querySelector('#thinking-frame')).toBeInTheDocument();
    });
  });

  it('shares one fetch across simultaneous animation mounts', async () => {
    render(
      <>
        <ThinkingAnimation autoplay={false} loop={false} dataUrl="/cached-animation.txt" />
        <ThinkingAnimation autoplay={false} loop={false} dataUrl="/cached-animation.txt" />
      </>,
    );

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch).toHaveBeenCalledWith('/cached-animation.txt');
    });
  });
});
