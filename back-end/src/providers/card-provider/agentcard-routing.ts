import { getOrgManagedCardholderId, getV2ConnectedUserId } from '../agentcard/store';
import { startV2Onboarding } from '../agentcard/v2-onboarding';
import { AgentCardV2Provider } from './agentcard-v2';
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
  resolveV2UserId?: (userId: string) => Promise<string | undefined>;
  startV2Onboarding?: (userId: string) => Promise<{ sessionId: string; setupUrl: string }>;
  createV2Provider?: (providerUserId?: string) => CardProvider;
};

const defaultDependencies: RoutingDependencies = {
  resolveOrgCardholderId: getOrgManagedCardholderId,
  startOrgOnboarding: startOrgCardholderOnboarding,
  createOrgProvider: (cardholderId) => new AgentCardOrgMcpProvider(cardholderId),
  createUserProvider: (userId) => new AgentCardUserMcpProvider(userId),
  resolveV2UserId: getV2ConnectedUserId,
  startV2Onboarding,
  createV2Provider: (providerUserId) => new AgentCardV2Provider(providerUserId),
};

export class AgentCardRoutingProvider implements CardProvider {
  private resolved?: Promise<{ org?: CardProvider; user: CardProvider }>;

  constructor(
    private readonly userId: string,
    private readonly dependencies: RoutingDependencies = defaultDependencies
  ) {}

  async mintCard(request: CardProviderMintRequest): Promise<CardProviderMintResult> {
    if (
      request.fundsSource === 'company_flow' &&
      this.dependencies.resolveV2UserId &&
      this.dependencies.createV2Provider &&
      this.dependencies.startV2Onboarding
    ) {
      const providerUserId = await this.dependencies.resolveV2UserId(this.userId);
      if (providerUserId) {
        try {
          return await this.dependencies.createV2Provider(providerUserId).mintCard(request);
        } catch (error) {
          if (
            !(error instanceof AgentCardProviderError) ||
            error.code !== 'agentcard_connection_not_found'
          )
            throw error;
        }
      }
      const onboarding = await this.dependencies.startV2Onboarding(this.userId);
      throw new AgentCardProviderError(
        'One Time Agent Payment Setup is required',
        409,
        undefined,
        'agentcard_setup_required',
        {
          agentcardStatus: 'cardholder_onboarding_required',
          setupStatus: 'connection_required',
          setupAction: 'complete_agentcard_cardholder_onboarding',
          setupUrl: onboarding.setupUrl,
          setupSessionId: onboarding.sessionId,
        }
      );
    }
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
    if (cardId.startsWith('card_') && this.dependencies.createV2Provider)
      return this.dependencies.createV2Provider().getDetails(cardId);
    const providers = await this.providers();
    return (providers.org ?? providers.user).getDetails(cardId);
  }

  async closeCard(cardId: string): Promise<void> {
    if (cardId.startsWith('card_') && this.dependencies.createV2Provider)
      return this.dependencies.createV2Provider().closeCard(cardId);
    const providers = await this.providers();
    return (providers.org ?? providers.user).closeCard(cardId);
  }

  private providers(): Promise<{ org?: CardProvider; user: CardProvider }> {
    this.resolved ??= this.dependencies
      .resolveOrgCardholderId(this.userId)
      .then((cardholderId) => ({
        ...(cardholderId !== undefined
          ? { org: this.dependencies.createOrgProvider(cardholderId) }
          : {}),
        user: this.dependencies.createUserProvider(this.userId),
      }));
    return this.resolved;
  }
}
