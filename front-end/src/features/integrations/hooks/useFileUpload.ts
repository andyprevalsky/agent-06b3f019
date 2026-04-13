import { useState, useRef, useCallback } from 'react';

import { uploadFileApi } from '../api';

export function useFileUpload() {
  const [uploading, setUploading] = useState<string | null>(null);
  const vcfInputRef = useRef<HTMLInputElement>(null);
  const emailZipInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = useCallback(async (type: 'vcf' | 'email-zip', file: File) => {
    const integrationName = type === 'vcf' ? 'Contacts (VCF)' : 'Email Export (ZIP)';
    setUploading(integrationName);
    try {
      const payload = await uploadFileApi(type, file);
      if (type === 'vcf') {
        return `Imported ${payload.created} new contacts, updated ${payload.updated}, skipped ${payload.skipped}`;
      }
      return payload.message || 'File uploaded successfully';
    } finally {
      setUploading(null);
    }
  }, []);

  return { uploading, vcfInputRef, emailZipInputRef, handleFileUpload } as const;
}
