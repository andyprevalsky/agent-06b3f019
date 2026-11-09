/** Read dynamically so explicit rollout changes take effect at each request. */
export function cloudPhoneRoutingEnabled(): boolean {
  return ['1', 'true'].includes(process.env.CLOUD_IPHONE_ENABLED ?? '');
}
