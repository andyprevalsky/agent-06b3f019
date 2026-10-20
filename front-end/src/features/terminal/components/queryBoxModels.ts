import type { Model } from '../types';

/** Models offered by the query box. */
export function queryBoxModels(models: Model[]): Model[] {
  return models.filter(
    (m) =>
      m.id === 'rose-labs/rose-1-flash' ||
      m.id === 'rose-labs/rose-fast' ||
      m.id === 'rose-labs/rose-1-lite' ||
      m.id === 'rose-labs/rose-1-ultra',
  );
}
