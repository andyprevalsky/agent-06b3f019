/**
 * STATE MACHINE: PlaidIntegrationHarness (test-only)
 *
 * Stateless wiring: renders the real PlaidSection driven by the real
 * usePlaidIntegration hook, so the Plaid blackbox exercises hook + view
 * together. Data builders live in plaid.fixtures.ts.
 */

import PlaidSection from '@/features/integrations/components/PlaidSection';
import { usePlaidIntegration } from '@/features/integrations/hooks/usePlaidIntegration';

export function PlaidIntegrationHarness() {
  const plaid = usePlaidIntegration();
  return (
    <PlaidSection
      items={plaid.items}
      itemsLoading={plaid.itemsLoading}
      connectLoading={plaid.connectLoading}
      disconnectingItemId={plaid.disconnectingItemId}
      error={plaid.error}
      onConnect={plaid.onConnect}
      onUpdate={plaid.onUpdate}
      onDisconnect={plaid.onDisconnect}
    />
  );
}
