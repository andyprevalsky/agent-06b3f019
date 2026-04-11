import { useState, useRef, useCallback } from 'react';

import type { CustomizationData } from './types';
import { MAX_FILE_SIZE_BYTES } from './config';
import { uploadProfilePicture } from './api';

/** Manages profile picture file upload state and validation. */
export function useFileUpload(
  data: CustomizationData,
  onChange: (data: CustomizationData) => void,
) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      if (!file.type.startsWith('image/')) {
        setUploadError('Please select an image file');
        return;
      }

      if (file.size > MAX_FILE_SIZE_BYTES) {
        setUploadError('Image must be smaller than 2MB');
        return;
      }

      setUploading(true);
      setUploadError(null);

      try {
        const publicUrl = await uploadProfilePicture(file);
        onChange({ ...data, profilePicture: publicUrl });
      } catch (error) {
        console.error('Upload error:', error);
        setUploadError(error instanceof Error ? error.message : 'Upload failed');
      } finally {
        setUploading(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [data, onChange],
  );

  return { uploading, uploadError, fileInputRef, handleFileUpload } as const;
}
