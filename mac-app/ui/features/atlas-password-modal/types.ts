/**
 * Types for the atlas-password-modal feature.
 *
 * The modal prompts users to paste the Atlas (ChatGPT Desktop) Safe Storage
 * keychain password. Atlas uses the Data Protection keychain which cannot
 * be accessed programmatically — users must manually retrieve the password
 * from Keychain Access.
 */

/**
 * What type of data the modal is collecting the password for. This only
 * affects the copy shown in the body + security notice.
 */
export type AtlasPasswordSyncType = 'cookies' | 'passwords' | 'browser data';

/**
 * Props for the `AtlasPasswordModal` component — the sole public surface
 * crossing the feature boundary.
 */
export interface AtlasPasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSync: (password: string) => Promise<void>;
  /** What type of data we're syncing - affects displayed text */
  syncType?: AtlasPasswordSyncType;
}

/**
 * Result of the `useAtlasPasswordModal` hook — the state + handlers the
 * component wires into its JSX. Keeps the component a pure renderer.
 */
export interface UseAtlasPasswordModalResult {
  password: string;
  loading: boolean;
  error: string | null;
  expandedImage: string | null;
  setPassword: (value: string) => void;
  setExpandedImage: (value: string | null) => void;
  handleOpenKeychain: () => Promise<void>;
  handleSync: () => Promise<void>;
  handleClose: () => void;
}
