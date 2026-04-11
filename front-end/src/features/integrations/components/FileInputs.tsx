/**
 * STATE MACHINE: FileInputs
 *
 * [MOUNTED] --> renders hidden file input elements for VCF and email ZIP uploads.
 */

import type { useFileUpload } from '../hooks/useFileUpload';

interface FileInputsProps {
  fileUpload: ReturnType<typeof useFileUpload>;
  onFileChange: (type: 'vcf' | 'email-zip', file: File) => void;
}

export default function FileInputs({ fileUpload, onFileChange }: FileInputsProps) {
  return (
    <>
      <input
        type="file"
        ref={fileUpload.vcfInputRef}
        accept=".vcf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            onFileChange('vcf', file);
            e.target.value = '';
          }
        }}
      />
      <input
        type="file"
        ref={fileUpload.emailZipInputRef}
        accept=".zip"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            onFileChange('email-zip', file);
            e.target.value = '';
          }
        }}
      />
    </>
  );
}
