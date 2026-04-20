import { useRef, useState } from 'react';
import { ACCEPTED_EXTENSION, CSV_REQUIRED_MESSAGE, GENERIC_IMPORT_FAILURE } from './config';
import type { UseApplePasswordsModalResult } from './types';

/**
 * All ApplePasswordsModal state lives here. The component is a pure
 * renderer over this hook's result. Business rules encoded:
 *
 *   - Only `.csv` files are accepted; non-CSV inputs surface an inline
 *     validation error and never become the selected file.
 *   - Picking a valid CSV after an error clears the error.
 *   - While `onSync` is in-flight the modal is "loading": every close path
 *     (Cancel button, backdrop click, X button) is a no-op, and Import is
 *     disabled so rapid double-clicks cannot fire `onSync` twice.
 *   - On `onSync` success, loading remains true — the parent is expected
 *     to close the modal. On `onSync` rejection, the error is surfaced and
 *     loading is cleared so the user can retry.
 */
export const useApplePasswordsModal = (
  onClose: () => void,
  onSync: (file: File) => Promise<void>
): UseApplePasswordsModalResult => {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [expandedImage, setExpandedImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onFileInputChange = (selectedFile: File | null): void => {
    if (selectedFile === null) return;
    if (!selectedFile.name.endsWith(ACCEPTED_EXTENSION)) {
      setError(CSV_REQUIRED_MESSAGE);
      return;
    }
    setFile(selectedFile);
    setError(null);
  };

  const onDragOver = (e: React.DragEvent): void => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const onDragLeave = (e: React.DragEvent): void => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setIsDragOver(false);
    const droppedFile = e.dataTransfer.files[0] ?? null;
    onFileInputChange(droppedFile);
  };

  const onSyncClick = async (): Promise<void> => {
    if (file === null) {
      setError(CSV_REQUIRED_MESSAGE);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await onSync(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : GENERIC_IMPORT_FAILURE);
      setLoading(false);
    }
  };

  const onCloseClick = (): void => {
    if (loading) return;
    setFile(null);
    setError(null);
    onClose();
  };

  return {
    file,
    loading,
    error,
    isDragOver,
    expandedImage,
    fileInputRef,
    setExpandedImage,
    onFileInputChange,
    onDragOver,
    onDragLeave,
    onDrop,
    onSyncClick,
    onCloseClick,
  };
};
