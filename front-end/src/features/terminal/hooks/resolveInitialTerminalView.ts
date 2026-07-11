import { getItem } from '@/lib/storage';

import { BROWSER_REVIEW_TEST_PHONE } from '../config';
import type { TerminalView } from '../types';

export function resolveInitialTerminalView(): TerminalView {
  if (new URL(window.location.href).searchParams.has('agent-id')) return 'agents';
  const stored = getItem('app-user');
  if (stored === null) return 'agents';
  try {
    const user = JSON.parse(stored) as { phone?: string };
    return user.phone === BROWSER_REVIEW_TEST_PHONE ? 'browse' : 'agents';
  } catch {
    return 'agents';
  }
}
