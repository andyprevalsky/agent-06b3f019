export function getWorldModelHarnessBaseUrl(): string {
  const primary = process.env.WMH_BASE_URL;
  const secondary = process.env.WORLD_MODEL_HARNESS_URL;
  const raw =
    primary !== undefined && primary.trim() !== ''
      ? primary
      : secondary !== undefined
        ? secondary
        : '';
  if (raw.trim() === '') {
    throw new Error('WMH_BASE_URL is not configured');
  }
  return raw.replace(/\/+$/, '');
}
