/** Match canonical Rose USER-facing pricing (agents/providers/rose/pricing.py).
 * Foundry is funded by Rose; this is not an assertion of zero provider cost.
 * Keep actual model and token usage in the billing receipt. */
import type { getModelPricing } from './modelPricing';
export async function phoneVerifierPricing(
  model: string,
  lookup: typeof getModelPricing
): Promise<{ prompt: string; completion: string } | null> {
  return ['-gpt', '-claude', '-foundry'].some((suffix) => model.endsWith(suffix))
    ? { prompt: '0', completion: '0' }
    : lookup(model);
}
