/**
 * Types for the apple-passwords-modal feature.
 *
 * Props cross the feature boundary (parent passes callbacks + open flag).
 * Hook-result types are feature-internal — exported for component typing.
 */

export interface ApplePasswordsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSync: (file: File) => Promise<void>;
}

/**
 * Result of the `useApplePasswordsModal` hook — all state + handlers a
 * renderer needs to draw the modal in its current state.
 */
export interface UseApplePasswordsModalResult {
  file: File | null;
  loading: boolean;
  error: string | null;
  isDragOver: boolean;
  expandedImage: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  setExpandedImage: (expanded: boolean) => void;
  onFileInputChange: (selectedFile: File | null) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onSyncClick: () => Promise<void>;
  onCloseClick: () => void;
  onOpenPasswordsClick: () => void;
}
