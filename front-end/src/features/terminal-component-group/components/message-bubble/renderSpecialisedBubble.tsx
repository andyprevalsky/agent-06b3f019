/**
 * Renders the "specialised" (tool-specific) sub-bubble for a message, or
 * returns undefined to let the dispatcher fall through to the generic
 * bubbles.
 *
 * Split across two helpers (`renderAgentRoutes`, `renderChipRoutes`) so each
 * function stays under the strict max-lines-per-function cap.
 */
import type { ReactElement } from 'react';
import type { MessageBubbleProps } from './types';
import type { MessageRouting } from './useMessageRouting';
import { renderAgentRoutes } from './renderAgentRoutes';
import { renderChipRoutes } from './renderChipRoutes';

interface Args {
  props: MessageBubbleProps;
  routing: MessageRouting;
}

export function renderSpecialisedBubble({ props, routing }: Args): ReactElement | null | undefined {
  const agent = renderAgentRoutes({ props, routing });
  if (agent !== undefined) return agent;
  return renderChipRoutes({ props, routing });
}
