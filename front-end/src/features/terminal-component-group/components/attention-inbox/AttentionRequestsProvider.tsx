/**
 * STATE MACHINE: AttentionRequestsProvider
 *
 * Holds the ONE attention-request subscription result for the app and fans it
 * out via context.
 *
 * [TerminalLayout] --useAttentionRequests() once--> value
 *        |
 *        +--> <AttentionRequestsProvider value>  -> AttentionInbox, MobileAgentDrawer
 *        +--> attentionAgentIds as a plain prop  -> AppSidebar -> rows
 *
 * Why this exists: useAttentionRequests opens a realtime channel AND a 10s poll.
 * The desktop bell and the mobile drawer each used to run their own, and wiring
 * the sidebar's run indicators to a third call would have tripled both the
 * channel count and the poll rate per signed-in user for identical data. One
 * subscription per user, regardless of how many components read it.
 *
 * Note the deliberate asymmetry: the inbox UIs consume context, but the sidebar
 * takes `attentionAgentIds` as a prop. AppSidebar and everything under it are
 * fully props-driven by convention (its blackbox suite mounts it bare), and a
 * context read would have quietly broken that.
 *
 * The context object and its readers live in attentionRequestsContext.ts so this
 * file exports only a component (React Fast Refresh requirement).
 */

import type { ReactNode } from 'react';

import { AttentionRequestsContext } from './attentionRequestsContext';
import type { UseAttentionRequestsResult } from './useAttentionRequests';

export function AttentionRequestsProvider({
  value,
  children,
}: {
  value: UseAttentionRequestsResult;
  children: ReactNode;
}) {
  return (
    <AttentionRequestsContext.Provider value={value}>{children}</AttentionRequestsContext.Provider>
  );
}
