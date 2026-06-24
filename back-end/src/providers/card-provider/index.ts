import { AgentCardProvider } from './agentcard';
import type { CardProvider } from './types';

export type {
  CardProvider,
  CardProviderDetailsResult,
  CardProviderMintRequest,
  CardProviderMintResult,
} from './types';
export { AgentCardProvider, AgentCardProviderError } from './agentcard';

export function createCardProvider(): CardProvider {
  return new AgentCardProvider();
}
