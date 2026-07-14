import { getOrgManagedCardholderId } from '../agentcard/store';
import { startOrgCardholderOnboarding } from '../agentcard/org-onboarding';
import { AgentCardOrgMcpProvider } from './agentcard-org-mcp';
import { AgentCardUserMcpProvider } from './agentcard-user-mcp';
import { AgentCardProviderError } from './errors';
import type {
  CardProvider,
  CardProviderDetailsResult,
  CardProviderMintRequest,
  CardProviderMintResult,
} from './types';

type RoutingDependencies = {
  resolveOrgCardholderId: (userId: string) => Promise<string | undefined>;
  startOrgOnboarding: (userId: string) => Promise<{ sessionId: string; setupUrl: string }>;
  createOrgProvider: (cardholderId: string) => CardProvider;
  createUserProvider: (userId: string) => CardProvider;
};

const defaultDependencies: RoutingDependencies = {
  resolveOrgCardholderId: getOrgManagedCardholderId,
  startOrgOnboarding: startOrgCardholderOnboarding,
  createOrgProvider: (cardholderId) => new AgentCardOrgMcpProvider(cardholderId),
  createUserProvider: (userId) => new AgentCardUserMcpProvider(userId),
};

export class AgentCardRoutingProvider implements CardProvider {
  private resolved?: Promise<{ org?: CardProvider; user: CardProvider }>;

  constructor(
    private readonly userId: string,
    private readonly dependencies: RoutingDependencies = defaultDependencies
  ) {}

  async mintCard(request: CardProviderMintRequest): Promise<CardProviderMintResult> {
    const providers = await this.providers();
    if (request.fundsSource === 'company_flow') {
      if (providers.org === undefined) {
        const onboarding = await this.dependencies.startOrgOnboarding(this.userId);
        throw new AgentCardProviderError(
          'One Time Agent Payment Setup is required',
          409,
          undefined,
          'agentcard_setup_required',
          {
            agentcardStatus: 'cardholder_onboarding_required',
            setupAction: 'complete_agentcard_cardholder_onboarding',
            setupTool: 'create_onboarding_session',
            setupUrl: onboarding.setupUrl,
            setupSessionId: onboarding.sessionId,
          }
        );
      }
      return providers.org.mintCard(request);
    }
    return (providers.org ?? providers.user).mintCard(request);
  }

  async getDetails(cardId: string): Promise<CardProviderDetailsResult> {
    const providers = await this.providers();
    return (providers.org ?? providers.user).getDetails(cardId);
  }

  async closeCard(cardId: string): Promise<void> {
    const providers = await this.providers();
    return (providers.org ?? providers.user).closeCard(cardId);
  }

  private providers(): Promise<{ org?: CardProvider; user: CardProvider }> {
    this.resolved ??= this.dependencies.resolveOrgCardholderId(this.userId).then((cardholderId) => ({
      ...(cardholderId !== undefined
        ? { org: this.dependencies.createOrgProvider(cardholderId) }
        : {}),
      user: this.dependencies.createUserProvider(this.userId),
    }));
    return this.resolved;
  }
}
