export const TEST_PAYMENT_ENABLED =
  process.env.NODE_ENV !== 'production' && process.env.ENABLE_TEST_PAYMENT !== 'false';
