import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  sameWorkflowHistoryMetrics,
  summarizeWorkflowHistory,
} from '../../providers/workflowHistoryMetrics';

describe('summarizeWorkflowHistory', () => {
  it('treats a started timer with no fire/cancel as active', () => {
    const metrics = summarizeWorkflowHistory([
      { eventId: '1', workflowTaskScheduledEventAttributes: {} },
      { eventId: '2', timerStartedEventAttributes: { timerId: '1' } },
    ]);
    assert.equal(metrics.timers, 1);
    assert.equal(metrics.activeTimers, 1);
  });

  it('does not treat a fired-only timer lifecycle as an armed handoff', () => {
    const metrics = summarizeWorkflowHistory([
      { eventId: '1', timerStartedEventAttributes: { timerId: '1' } },
      {
        eventId: '2',
        timerFiredEventAttributes: { startedEventId: '1' },
      },
    ]);
    assert.equal(metrics.timers, 2);
    assert.equal(metrics.activeTimers, 0);
  });

  it('does not treat a canceled-only timer lifecycle as an armed handoff', () => {
    const metrics = summarizeWorkflowHistory([
      { eventId: '10', timerStartedEventAttributes: { timerId: 'wait' } },
      {
        eventId: '11',
        timerCanceledEventAttributes: { startedEventId: '10' },
      },
    ]);
    assert.equal(metrics.timers, 2);
    assert.equal(metrics.activeTimers, 0);
  });

  it('sameWorkflowHistoryMetrics includes activeTimers', () => {
    const a = summarizeWorkflowHistory([{ eventId: '1', timerStartedEventAttributes: {} }]);
    const b = summarizeWorkflowHistory([
      { eventId: '1', timerStartedEventAttributes: {} },
      { eventId: '2', timerFiredEventAttributes: { startedEventId: '1' } },
    ]);
    assert.equal(sameWorkflowHistoryMetrics(a, a), true);
    assert.equal(sameWorkflowHistoryMetrics(a, b), false);
  });
});
