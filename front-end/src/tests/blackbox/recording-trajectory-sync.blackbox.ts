/**
 * Unit tests for recording playhead ↔ trajectory step mapping.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTrajectorySteps,
  findActiveStepIndex,
  playheadFromSegments,
  resolveRecordingStartMs,
  seekTargetFromOffset,
} from '@/features/terminal-component-group/components/browser-agent-chip/recordingTrajectorySync';

describe('recordingTrajectorySync', () => {
  const messages = [
    {
      timestamp: '2026-08-31T16:51:30.000Z',
      metadata: { action_type: 'recording', toolStatus: 'IN_PROGRESS', title: 'Recording started' },
    },
    {
      timestamp: '2026-08-31T16:51:35.000Z',
      metadata: { action_type: 'goto', toolStatus: 'FINISHED', title: 'Open bluebottlecoffee.com' },
      text: 'navigated',
    },
    {
      timestamp: '2026-08-31T16:52:10.000Z',
      metadata: { action_type: 'click', toolStatus: 'FINISHED', title: 'Click Almond Oat Latte' },
    },
    {
      timestamp: '2026-08-31T16:53:00.000Z',
      metadata: { action_type: 'type', toolStatus: 'FINISHED', title: 'Enter guest email' },
    },
    {
      timestamp: '2026-08-31T17:08:00.000Z',
      metadata: { action_type: 'recording', toolStatus: 'FINISHED', title: 'Recording saved' },
    },
  ];

  it('anchors recording start on the first recording message', () => {
    expect(resolveRecordingStartMs(messages)).toBe(Date.parse('2026-08-31T16:51:30.000Z'));
  });

  it('builds trajectory offsets relative to recording start and skips recording rows', () => {
    const start = resolveRecordingStartMs(messages);
    const steps = buildTrajectorySteps(messages, start);
    expect(steps.map((s) => s.action)).toEqual(['goto', 'click', 'type']);
    expect(steps.map((s) => s.offsetSec)).toEqual([5, 40, 90]);
  });

  it('finds the latest step at or before the playhead (scrub mapping)', () => {
    const steps = buildTrajectorySteps(messages, resolveRecordingStartMs(messages));
    expect(findActiveStepIndex(steps, 0)).toBe(-1);
    expect(findActiveStepIndex(steps, 5)).toBe(0);
    expect(findActiveStepIndex(steps, 39.9)).toBe(0);
    expect(findActiveStepIndex(steps, 40)).toBe(1);
    expect(findActiveStepIndex(steps, 90)).toBe(2);
    expect(findActiveStepIndex(steps, 1000)).toBe(2);
  });

  it('accumulates multi-segment playheads from prior durations + currentTime', () => {
    expect(playheadFromSegments([10, 20], 0, 3)).toBe(3);
    expect(playheadFromSegments([10, 20], 1, 4)).toBe(14);
    expect(playheadFromSegments([10, 20], 2, 5)).toBe(35);
  });

  it('keeps full step titles (no 80-char slice) so the live panel can wrap them', () => {
    const long =
      'Probing 5 cookie variant(s) in parallel on ephemeral browser sessions (not the live debug desktop; known challenge strips may commit, others are diagnostic).';
    const steps = buildTrajectorySteps(
      [
        {
          timestamp: '2026-08-31T16:51:30.000Z',
          metadata: { action_type: 'recording' },
        },
        {
          timestamp: '2026-08-31T16:51:35.000Z',
          metadata: { action_type: 'browser_challenge_recovery', title: long },
        },
      ],
      Date.parse('2026-08-31T16:51:30.000Z'),
    );
    expect(steps[0].title).toBe(long);
    expect(steps[0].title.length).toBeGreaterThan(80);
  });

  it('maps a wall-clock offset back to the correct segment + local time for click-seek', () => {
    expect(seekTargetFromOffset(3, [10, 20])).toEqual({ segmentIndex: 0, timeInSegment: 3 });
    expect(seekTargetFromOffset(14, [10, 20])).toEqual({ segmentIndex: 1, timeInSegment: 4 });
    expect(seekTargetFromOffset(35, [10, 20])).toEqual({ segmentIndex: 1, timeInSegment: 25 });
    expect(seekTargetFromOffset(7, [])).toEqual({ segmentIndex: 0, timeInSegment: 7 });
  });
});
