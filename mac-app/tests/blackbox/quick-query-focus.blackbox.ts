/**
 * Focus helper must never open the paperclip file picker.
 */

import { describe, it, expect } from 'vitest';
import { QUICK_QUERY_FOCUS_SCRIPT } from '../../main/app/quickQueryFocus';

describe('quickQueryFocus script', () => {
  it('targets the textarea only and never clicks a generic input', () => {
    expect(QUICK_QUERY_FOCUS_SCRIPT).toContain("querySelector('textarea')");
    expect(QUICK_QUERY_FOCUS_SCRIPT).not.toMatch(/querySelector\('textarea,\s*input'\)/);
    expect(QUICK_QUERY_FOCUS_SCRIPT).not.toMatch(/\.click\s*\(/);
    expect(QUICK_QUERY_FOCUS_SCRIPT).toContain('.focus(');
  });
});
