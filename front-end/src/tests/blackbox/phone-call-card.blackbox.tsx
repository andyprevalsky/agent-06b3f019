/**
 * Blackbox tests for PhoneCallCard component.
 * Covers call-state branches (in-progress/ended/error), duration formatting,
 * timer, transcript/summary rendering, and the mute/expand interactions.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PhoneCallCard, type PhoneCallMetadata } from '@/features/terminal-component-group/components/PhoneCallCard';

function makeCall(overrides: Partial<PhoneCallMetadata> = {}): PhoneCallMetadata {
  return {
    status: 'in-progress',
    to: '+15555550000',
    ...overrides,
  } as PhoneCallMetadata;
}

describe('PhoneCallCard', () => {
  describe('in-progress call', () => {
    it('renders the phone number and in-progress status text', () => {
      const started = new Date(Date.now() - 5_000).toISOString();
      render(
        <PhoneCallCard
          phoneCall={makeCall({ status: 'in-progress', startedAt: started })}
          toolStatus="IN_PROGRESS"
        />,
      );
      expect(screen.getByText('+15555550000')).toBeInTheDocument();
      expect(screen.getByText('Call in progress...')).toBeInTheDocument();
      // CallTimer renders m:ss
      expect(document.querySelector('.tabular-nums')!.textContent).toMatch(/^\d+:\d\d$/);
    });

    it('shows audio controls (mute button) when listenUrl is present', async () => {
      const u = userEvent.setup();
      render(
        <PhoneCallCard
          phoneCall={makeCall({
            status: 'in-progress',
            startedAt: new Date().toISOString(),
            listenUrl: 'ws://example.test/audio',
          })}
          toolStatus="IN_PROGRESS"
        />,
      );
      // Two buttons should be present (mute) — ExpandChevron is only for finished
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThanOrEqual(1);
      // Click mute — should not throw (toggles muted state)
      await u.click(buttons[0]);
    });

    it('fires onTypingComplete immediately on mount', async () => {
      let done = false;
      render(
        <PhoneCallCard
          phoneCall={makeCall({ status: 'in-progress' })}
          toolStatus="IN_PROGRESS"
          onTypingComplete={() => {
            done = true;
          }}
        />,
      );
      // rAF fires in microtask queue
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      expect(done).toBe(true);
    });
  });

  describe('finished call', () => {
    it('formats duration as m:ss', () => {
      render(
        <PhoneCallCard
          phoneCall={makeCall({
            status: 'ended',
            duration: 125, // 2:05
            endedReason: 'hangup',
          })}
          toolStatus="FINISHED"
        />,
      );
      expect(screen.getByText('2:05')).toBeInTheDocument();
      expect(screen.getByText('Ended: hangup')).toBeInTheDocument();
    });

    it('expands to show transcript, summary, and structured data on header click', async () => {
      const u = userEvent.setup();
      render(
        <PhoneCallCard
          phoneCall={makeCall({
            status: 'ended',
            duration: 30,
            endedReason: 'complete',
            transcript: 'Hello\nWorld',
            summary: 'Call summary text',
            structuredData: { appointmentBooked: true, time: '2pm' },
          })}
          toolStatus="FINISHED"
        />,
      );
      // Initially collapsed — transcript is not shown
      expect(screen.queryByText('Transcript')).not.toBeInTheDocument();

      // Click the header (the phone number is inside it)
      const header = screen.getByText('+15555550000').closest('div')!.parentElement!.parentElement!;
      await u.click(header);

      expect(screen.getByText('Transcript')).toBeInTheDocument();
      expect(screen.getByText(/Hello/)).toBeInTheDocument();
      expect(screen.getByText('Summary')).toBeInTheDocument();
      expect(screen.getByText('Call summary text')).toBeInTheDocument();
      expect(screen.getByText('Extracted Data')).toBeInTheDocument();
      expect(screen.getByText(/appointmentBooked/)).toBeInTheDocument();
    });

    it('shows recording player UI when expanded and recordingUrl is set', async () => {
      const u = userEvent.setup();
      render(
        <PhoneCallCard
          phoneCall={makeCall({
            status: 'ended',
            duration: 10,
            endedReason: 'complete',
            recordingUrl: 'https://example.test/rec.mp3',
          })}
          toolStatus="FINISHED"
        />,
      );
      // Header click to expand
      const header = screen.getByText('+15555550000').closest('div')!.parentElement!.parentElement!;
      await u.click(header);

      const audio = document.querySelector('audio');
      expect(audio).not.toBeNull();
      expect(audio!.getAttribute('src')).toBe('https://example.test/rec.mp3');

      // Player includes a play button — click it (mock play resolves via setup)
      const playButtons = document.querySelectorAll('button');
      // Click first play control inside the player
      const playBtn = Array.from(playButtons).find(
        (btn) => btn.querySelector('svg.lucide-play') || btn.querySelector('svg.lucide-pause'),
      );
      expect(playBtn).toBeDefined();
      await u.click(playBtn!);
    });

    it('omits duration when it is 0 or missing', () => {
      render(
        <PhoneCallCard
          phoneCall={makeCall({ status: 'ended', duration: 0, endedReason: 'no-answer' })}
          toolStatus="FINISHED"
        />,
      );
      expect(screen.getByText('Ended: no-answer')).toBeInTheDocument();
      // Only dot separator shouldn't be rendered for zero duration
      expect(screen.queryByText('0:00')).not.toBeInTheDocument();
    });
  });

  describe('error call', () => {
    it('renders the error message', () => {
      render(
        <PhoneCallCard
          phoneCall={makeCall({ status: 'error', error: 'Number disconnected' })}
          toolStatus="ERROR"
        />,
      );
      expect(screen.getByText('Number disconnected')).toBeInTheDocument();
      // Error styling adds red-500 colour class on the icon
      const phoneIcon = document.querySelector('.text-red-500');
      expect(phoneIcon).not.toBeNull();
    });
  });
});
