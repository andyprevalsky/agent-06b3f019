import { describe, it, expect } from 'vitest';
import {
  formatTerminalOutputForDisplay,
  normalizeTerminalWhitespace,
} from '@/features/terminal-component-group/components/claudeCodeChip.terminal';
import { ParseCodeAgentTranscript as parseCodeAgentTranscript } from '@/features/terminal-component-group/components/claudeCodeChip.transcript';

describe('code-agent terminal formatting', () => {
  it('adds readable ANSI section labels for terminal action markers', () => {
    const formatted = formatTerminalOutputForDisplay(
      '[Codex command output]\nhello\n[Codex exit code] 0',
    );

    expect(formatted).toContain('▶ Codex output');
    expect(formatted).toContain('✓ Codex exit');
    expect(formatted).toContain('\x1b[');
  });

  it('collapses runaway terminal indentation while preserving real code indentation', () => {
    const normalized = normalizeTerminalWhitespace(
      [
        'current = start',
        '                                                                                                while current <= end:',
        '    if weekday == 0:',
        '                                                                                                                         day_number = (current - start).days + 1',
      ].join('\n'),
    );

    expect(normalized).toContain('\n  while current <= end:');
    expect(normalized).toContain('\n    if weekday == 0:');
    expect(normalized).toContain('\n  day_number = (current - start).days + 1');
    expect(normalized).not.toMatch(/\n {24,}\S/);
  });

  it('parses completed code-agent output into color-coded transcript sections', () => {
    const blocks = parseCodeAgentTranscript(
      [
        `[Codex command started] /bin/bash -lc "python3 - <<'PY'"`,
        'from datetime import date, datetime',
        '[Codex command output]',
        'csv module parse: OK',
        'row_count=156',
        '[Codex exit_code] 0',
        '[Codex] Created and committed the calendar CSV.',
        'Artifacts:',
        '- `/home/user/content_calendar_90_days.csv`',
        'Verification:',
        '- `csv.DictReader`: OK',
      ].join('\n'),
    );

    expect(blocks.map((block) => block.kind)).toEqual([
      'command',
      'output',
      'exit',
      'agent',
      'status',
      'status',
    ]);
    expect(blocks.find((block) => block.kind === 'output')?.lines.join('\n')).toContain(
      'row_count=156',
    );
    expect(blocks.find((block) => block.title === 'Exited cleanly')?.tone).toBe('green');
  });

  it('parses Claude tool markers into icon tool rows instead of Claude notes', () => {
    const blocks = parseCodeAgentTranscript(
      [
        '[Claude] Session started in /home/user',
        "[Claude] I'll start by checking GitHub access.",
        '[Claude tool] Bash · gh auth status',
        '[Claude tool] Write · /home/user/discovery.py',
        '[Claude] Confirmed: unauthenticated access only.',
        '[Claude tool] Bash',
        '[Claude result] done',
      ].join('\n'),
    );

    expect(blocks.map((block) => block.kind)).toEqual([
      'agent',
      'tool',
      'tool',
      'agent',
      'tool',
      'result',
    ]);
    // Consecutive Claude notes merge into one coherent agent block.
    expect(blocks[0]?.lines.join('\n')).toContain('Session started in /home/user');
    expect(blocks[0]?.lines.join('\n')).toContain("I'll start by checking GitHub access.");
    expect(blocks[0]?.title).toBe('Claude');
    expect(blocks.find((block) => block.title === 'Bash')?.lines).toEqual(['gh auth status']);
    expect(blocks.find((block) => block.title === 'Write')?.lines).toEqual([
      '/home/user/discovery.py',
    ]);
    // Tools must not be swallowed under a "Claude note" dump.
    expect(blocks.some((block) => block.title === 'Claude note')).toBe(false);
  });

  it('heals staircase mid-token wraps so tool rows stay readable', () => {
    const blocks = parseCodeAgentTranscript(
      [
        '[Claude] Session started in /home/user',
        "                                      [Claude] I'll start by checking GitHub access.",
        '                                                           [Claude tool] Bas',
        'h',
        ' [Claude tool] Bash',
        '                   [Claude tool] Write',
        '[Claude] Now the discovery runner with checkpointi',
        'ng/resumability:',
      ].join('\n'),
    );

    expect(blocks.map((block) => block.kind)).toEqual(['agent', 'tool', 'tool', 'tool', 'agent']);
    expect(blocks.filter((block) => block.kind === 'tool').map((block) => block.title)).toEqual([
      'Bash',
      'Bash',
      'Write',
    ]);
    expect(blocks[blocks.length - 1]?.lines.join('\n')).toContain(
      'discovery runner with checkpointing/resumability:',
    );
    expect(blocks.some((block) => block.title === 'Bas')).toBe(false);
    expect(blocks.some((block) => block.title === 'Claude note')).toBe(false);
  });

  it('preserves word boundaries when a wrapped tool name is followed by its detail', () => {
    const blocks = parseCodeAgentTranscript(
      ['[Claude tool] Bash', 'npm test --runInBand'].join('\n'),
    );
    const bash = blocks.find((block) => block.kind === 'tool' && block.title === 'Bash');
    expect(bash).toBeDefined();
    expect(bash?.lines).toEqual(['npm test --runInBand']);
    expect(blocks.some((block) => block.title === 'Bashnpm')).toBe(false);
  });
});
