const STRIPE_RECOVERY_CONCURRENCY = 4;

type StripeUserIdLookup = (subscriptionId: string) => Promise<string | null | undefined>;

export async function recoverMissingStripeUserIds(
  subscriptionIdsByCustomerId: ReadonlyMap<string, readonly string[]>,
  userIdByCustomerId: Map<string, string>,
  lookupUserId: StripeUserIdLookup,
  concurrency = STRIPE_RECOVERY_CONCURRENCY
): Promise<void> {
  const missingCustomers = Array.from(subscriptionIdsByCustomerId).filter(
    ([customerId]) => !userIdByCustomerId.has(customerId)
  );
  let nextCustomerIndex = 0;

  const recoverNextCustomer = async (): Promise<void> => {
    while (nextCustomerIndex < missingCustomers.length) {
      const customer = missingCustomers[nextCustomerIndex];
      nextCustomerIndex += 1;
      if (customer === undefined) return;
      const [customerId, subscriptionIds] = customer;
      for (const subscriptionId of subscriptionIds) {
        const userId = await lookupUserId(subscriptionId);
        if (userId !== undefined && userId !== null && userId !== '') {
          userIdByCustomerId.set(customerId, userId);
          break;
        }
      }
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), missingCustomers.length);
  await Promise.all(Array.from({ length: workerCount }, recoverNextCustomer));
}
