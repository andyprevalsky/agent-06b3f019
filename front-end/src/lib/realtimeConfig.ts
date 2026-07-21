export function shouldUsePrivateRealtimeChannels(
  explicitSetting: string | undefined,
  isDev: boolean,
): boolean {
  if (explicitSetting === 'true') return true;
  if (explicitSetting === 'false') return false;
  return !isDev;
}

export const USE_PRIVATE_REALTIME_CHANNELS = shouldUsePrivateRealtimeChannels(
  import.meta.env.VITE_REALTIME_PRIVATE,
  import.meta.env.DEV,
);
