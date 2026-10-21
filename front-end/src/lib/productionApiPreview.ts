/** Explicit transport policy for a development UI connected to Rose's production API. */
export const PRODUCTION_API_PREVIEW_DEFINES: Record<string, string> = {
  'import.meta.env.VITE_REALTIME_PRIVATE': JSON.stringify('true'),
};
