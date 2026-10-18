/** Stable domain entrypoint; explicit exports preserve fresh-worker ESM interop. */
export {
  privacyState,
  rememberPrivate,
  resumedPrivacy,
  isModelMedia,
  privateResult,
} from '../../providers/phoneInputPrivacy';
export type { PhonePrivacy } from '../../providers/phoneInputPrivacy';
