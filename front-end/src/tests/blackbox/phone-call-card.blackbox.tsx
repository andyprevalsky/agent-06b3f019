/**
 * Blackbox tests for PhoneCallCard component.
 * Covers call-state branches (in-progress/ended/error), duration formatting,
 * timer, transcript/summary rendering, and the mute/expand interactions.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  PhoneCallCard,
  type PhoneCallMetadata,
} from '@/features/terminal-component-group/components/PhoneCallCard';

vi.mock('@/features/terminal-component-group/api', async (importActual) => ({
  ...(await importActual<typeof import('@/features/terminal-component-group/api')>()),
  fetchPhoneCallRecording: vi.fn(
    async () => new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: 'audio/wav' }),
  ),
}));

import { fetchPhoneCallRecording } from '@/features/terminal-component-group/api';

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

  describe('on-hold call', () => {
    it('shows the hold status and hold timer without live audio controls', () => {
      render(
        <PhoneCallCard
          phoneCall={makeCall({
            status: 'on-hold',
            startedAt: new Date(Date.now() - 3_600_000).toISOString(),
            holdStartedAt: new Date(Date.now() - 65_000).toISOString(),
            listenUrl: 'ws://example.test/audio',
          })}
          toolStatus="IN_PROGRESS"
        />,
      );
      expect(screen.getByText('On hold, waiting for a live person...')).toBeInTheDocument();
      expect(screen.queryByText('Call in progress...')).not.toBeInTheDocument();
      // The timer counts the hold, not the whole call.
      expect(document.querySelector('.tabular-nums')!.textContent).toMatch(/^1:0\d$/);
      expect(screen.queryAllByRole('button')).toHaveLength(0);
      expect(document.querySelector('.text-amber-500')).not.toBeNull();
    });

    it('returns to the live view when the call resumes', () => {
      const { rerender } = render(
        <PhoneCallCard
          phoneCall={makeCall({ status: 'on-hold', startedAt: new Date().toISOString() })}
          toolStatus="IN_PROGRESS"
        />,
      );
      rerender(
        <PhoneCallCard
          phoneCall={makeCall({
            status: 'in-progress',
            startedAt: new Date().toISOString(),
            listenUrl: 'ws://example.test/audio-2',
          })}
          toolStatus="IN_PROGRESS"
        />,
      );
      expect(screen.getByText('Call in progress...')).toBeInTheDocument();
      expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(1);
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

    it('plays a first-party recording blob instead of a provider URL', async () => {
      const u = userEvent.setup();
      render(
        <PhoneCallCard
          agentId="agent-1"
          phoneCall={makeCall({
            status: 'ended',
            duration: 10,
            endedReason: 'complete',
            callId: 'call-1',
            recordingUrl: 'https://example.test/rec.mp3',
          })}
          toolStatus="FINISHED"
        />,
      );
      const header = screen.getByText('+15555550000').closest('div')!.parentElement!.parentElement!;
      await u.click(header);

      await waitFor(() => {
        expect(fetchPhoneCallRecording).toHaveBeenCalledWith(
          'agent-1',
          'call-1',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      });
      const audio = document.querySelector('audio');
      expect(audio).not.toBeNull();
      expect(audio!.getAttribute('src')).toMatch(/^blob:/);

      const playButtons = document.querySelectorAll('button');
      const playBtn = Array.from(playButtons).find(
        (btn) => btn.querySelector('svg.lucide-play') || btn.querySelector('svg.lucide-pause'),
      );
      expect(playBtn).toBeDefined();
      await u.click(playBtn!);
    });

    it('does not use a private Vapi recording URL as the audio src', async () => {
      const u = userEvent.setup();
      const privateUrl =
        'https://94bdb67bb98da30b06bdd917725c037d.r2.cloudflarestorage.com/hipaa-recordings/01a11772-75ae-7000-83c6-064e004a57af-mono.wav';
      render(
        <PhoneCallCard
          agentId="b31c8a09-5992-4916-b797-b9c3ae5c75cf"
          phoneCall={makeCall({
            status: 'ended',
            duration: 268,
            endedReason: 'silence-timed-out',
            callId: '01a11772-75ae-7000-83c6-064e004a57af',
            recordingUrl: privateUrl,
          })}
          toolStatus="FINISHED"
        />,
      );
      const header = screen.getByText('+15555550000').closest('div')!.parentElement!.parentElement!;
      await u.click(header);

      await waitFor(() => {
        const audio = document.querySelector('audio');
        expect(audio).not.toBeNull();
      });
      const audio = document.querySelector('audio');
      expect(audio?.getAttribute('src')).not.toBe(privateUrl);
      expect(audio?.getAttribute('src') ?? '').not.toContain('r2.cloudflarestorage.com');
      expect(audio?.getAttribute('src') ?? '').not.toContain('hipaa-recordings');
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
