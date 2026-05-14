import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Search } from 'lucide-react';
import { ExploreActiveToolCarousel } from '@/features/terminal-component-group/components/ExploreActiveToolCarousel';

vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      span: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
        <span {...props}>{children}</span>
      ),
    },
    useReducedMotion: () => true,
    useMotionValue: (initial: number) => ({ initial }),
    animate: (
      _motionValue: unknown,
      targetValue: number,
      options?: { onUpdate?: (latest: number) => void },
    ) => {
      options?.onUpdate?.(targetValue);
      return { stop: () => {} };
    },
  };
});

describe('ExploreActiveToolCarousel', () => {
  it('dedupes repeated visible tool items and pauses 1.8s between rotations', () => {
    vi.useFakeTimers();

    render(
      <ExploreActiveToolCarousel
        iconClassName="h-3 w-3"
        items={[
          { key: 'search-1', text: 'Searching the web for cities', icon: Search },
          { key: 'search-2', text: 'Searching the web for cities', icon: Search },
          { key: 'search-3', text: 'Searching the web for vacations', icon: Search },
        ]}
      />,
    );

    expect(screen.getByText('Searching the web for cities')).toBeInTheDocument();
    expect(screen.queryByText('Searching the web for vacations')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1700);
    });
    expect(screen.getByText('Searching the web for cities')).toBeInTheDocument();
    expect(screen.queryByText('Searching the web for vacations')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByText('Searching the web for vacations')).toBeInTheDocument();
    expect(screen.queryByText('Searching the web for cities')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(screen.getByText('Searching the web for vacations')).toBeInTheDocument();
    expect(screen.queryByText('Searching the web for cities')).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  it('shows a newly appended tool once without rotating back to the old tool', () => {
    vi.useFakeTimers();

    const { rerender } = render(
      <ExploreActiveToolCarousel
        iconClassName="h-3 w-3"
        items={[{ key: 'search-a', text: 'Tool call A', icon: Search }]}
      />,
    );

    expect(screen.getByText('Tool call A')).toBeInTheDocument();

    rerender(
      <ExploreActiveToolCarousel
        iconClassName="h-3 w-3"
        items={[
          { key: 'search-a', text: 'Tool call A', icon: Search },
          { key: 'search-b', text: 'Tool call B', icon: Search },
        ]}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(screen.getByText('Tool call B')).toBeInTheDocument();
    expect(screen.queryByText('Tool call A')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(screen.getByText('Tool call B')).toBeInTheDocument();
    expect(screen.queryByText('Tool call A')).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  it('does not reset or remount the thinking item on equivalent rerenders', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const { rerender } = render(
      <ExploreActiveToolCarousel
        iconClassName="h-3 w-3"
        items={[{ key: 'thinking-stream', kind: 'thinking', tokenCount: 0 }]}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(screen.getByText(/1\.2s/)).toBeInTheDocument();

    rerender(
      <ExploreActiveToolCarousel
        iconClassName="h-3 w-3"
        items={[{ key: 'thinking-stream-rerendered', kind: 'thinking', tokenCount: 4 }]}
      />,
    );

    expect(screen.getByText(/1\.2s/)).toBeInTheDocument();
    expect(screen.queryByText(/0\.0s/)).not.toBeInTheDocument();

    vi.useRealTimers();
  });
});
