/**
 * Debug flag detection for FeatureVideoStage.
 *
 * Uses canonical helpers from `@/lib/url` and `@/lib/storage` so domain code
 * stays free of direct `window.location` / `localStorage` access.
 */

import { getItem } from '@/lib/storage';
import { getQueryParams } from '@/lib/url';
import {
  FV_DEBUG_QUERY_KEY,
  FV_DEBUG_STORAGE_KEY,
  FV_DISABLE_RAMP_QUERY_KEY,
  FV_DISABLE_RAMP_STORAGE_KEY,
  FV_DISABLE_WARMUP_QUERY_KEY,
  FV_DISABLE_WARMUP_STORAGE_KEY,
  FV_NO_BLOB_QUERY_KEY,
  FV_NO_BLOB_STORAGE_KEY,
} from '../config';

function readFlag(queryKey: string, storageKey: string): boolean {
  try {
    const params = getQueryParams();
    if (params.get(queryKey) === '1') return true;
  } catch {
    // location unavailable — fall through to storage
  }
  return getItem(storageKey) === '1';
}

export interface VideoDebugFlags {
  debugEnabled: boolean;
  noBlob: boolean;
  disableRamp: boolean;
  disableWarmup: boolean;
}

export function readDebugFlags(): VideoDebugFlags {
  return {
    debugEnabled: readFlag(FV_DEBUG_QUERY_KEY, FV_DEBUG_STORAGE_KEY),
    noBlob: readFlag(FV_NO_BLOB_QUERY_KEY, FV_NO_BLOB_STORAGE_KEY),
    disableRamp: readFlag(FV_DISABLE_RAMP_QUERY_KEY, FV_DISABLE_RAMP_STORAGE_KEY),
    disableWarmup: readFlag(FV_DISABLE_WARMUP_QUERY_KEY, FV_DISABLE_WARMUP_STORAGE_KEY),
  };
}
