import { describe, expect, it } from 'vitest';
import { userFacingMessageText } from '@/lib/userFacingMessage';

describe('userFacingMessageText', () => {
  it('keeps ordinary research copy', () => {
    expect(userFacingMessageText('Huberman posts 3x/week on YouTube.')).toBe(
      'Huberman posts 3x/week on YouTube.',
    );
  });

  it('blanks Fast Mode parallel-replay chips', () => {
    expect(
      userFacingMessageText(
        'Fast Mode parallel replay: explore started and will run its full cached trajectory before this agent completes.',
      ),
    ).toBe('');
  });

  it('strips Fast Mode sentences from mixed copy', () => {
    expect(
      userFacingMessageText(
        'Cadence looks weekly. Fast Mode cache trajectory ended. Keep the 90-day plan.',
      ),
    ).toBe('Cadence looks weekly. Keep the 90-day plan.');
  });

  it('leaves user-typed empty strings empty', () => {
    expect(userFacingMessageText('')).toBe('');
    expect(userFacingMessageText(undefined)).toBe('');
  });
});
