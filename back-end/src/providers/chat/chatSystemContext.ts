/** Static phase instructions retain their cache prefix; project and profile share the suffix. */
import { markCacheable } from '../rose';
import {
  GENERATOR_SYSTEM_PROMPT,
  ROUTER_AFTER_SEARCH_SYSTEM_PROMPT,
  ROUTER_SEARCH_BUDGET_SPENT_SYSTEM_PROMPT,
  ROUTER_SYSTEM_PROMPT,
} from './chatPrompts';
import {
  ROUTER_JSON_SCHEMA,
  ROUTER_SEARCH_BUDGET_SPENT_JSON_SCHEMA,
} from './routerDecisionJsonSchema';
import type { RouterStage } from './routerDecision';

export const ROUTER_STAGES = {
  initial: {
    callSite: 'chat_router',
    systemPrompt: ROUTER_SYSTEM_PROMPT,
    schema: ROUTER_JSON_SCHEMA,
  },
  after_search: {
    callSite: 'chat_router_after_search',
    systemPrompt: ROUTER_AFTER_SEARCH_SYSTEM_PROMPT,
    schema: ROUTER_JSON_SCHEMA,
  },
  search_budget_spent: {
    callSite: 'chat_router_after_search',
    systemPrompt: ROUTER_SEARCH_BUDGET_SPENT_SYSTEM_PROMPT,
    schema: ROUTER_SEARCH_BUDGET_SPENT_JSON_SCHEMA,
  },
} as const;
/** Static stage prompt (cached prefix), then the agent's project section (projectContext.ts). */
export const buildRouterSystemMessage = (
  stage: RouterStage,
  projectContext = '',
  userProfileContext = ''
) =>
  markCacheable(
    ROUTER_STAGES[stage].systemPrompt,
    [projectContext, userProfileContext].filter(Boolean).join('\n\n')
  );

/** Static generator prompt (cached prefix), then the agent's project section (projectContext.ts). */
export const buildGeneratorSystemMessage = (projectContext = '', userProfileContext = '') =>
  markCacheable(
    GENERATOR_SYSTEM_PROMPT,
    [projectContext, userProfileContext].filter(Boolean).join('\n\n')
  );
