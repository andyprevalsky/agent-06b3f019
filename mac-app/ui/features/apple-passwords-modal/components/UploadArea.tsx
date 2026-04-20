/**
 * Drag-and-drop + click-to-pick upload area. Renders its own selected-file
 * summary and delegates all state transitions to the parent hook.
 */

import { FileText, Upload } from 'lucide-react';

interface UploadAreaProps {
  file: File | null;
  isDragOver: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileInputChange: (selectedFile: File | null) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

const borderClass = (isDragOver: boolean, file: File | null): string => {
  if (isDragOver) return 'border-primary bg-primary/5';
  if (file !== null) return 'border-green-500 bg-green-500/5';
  return 'border-border hover:border-primary/50';
};

const UploadArea = ({
  file,
  isDragOver,
  fileInputRef,
  onFileInputChange,
  onDragOver,
  onDragLeave,
  onDrop,
}: UploadAreaProps): React.ReactElement => (
  <div
    className={`relative border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${borderClass(
      isDragOver,
      file
    )}`}
    onDragOver={onDragOver}
    onDragLeave={onDragLeave}
    onDrop={onDrop}
    onClick={() => fileInputRef.current?.click()}
  >
    <input
      ref={fileInputRef}
      type="file"
      accept=".csv"
      className="hidden"
      onChange={(e) => onFileInputChange(e.target.files?.[0] ?? null)}
    />

    {file !== null ? (
      <div className="flex flex-col items-center gap-2">
        <FileText className="w-8 h-8 text-green-600 dark:text-green-400" />
        <p className="text-sm font-medium text-foreground">{file.name}</p>
        <p className="text-xs text-muted-foreground">Click or drag to replace</p>
      </div>
    ) : (
      <div className="flex flex-col items-center gap-2">
        <Upload className="w-8 h-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Click to upload</span> or drag and drop
        </p>
        <p className="text-xs text-muted-foreground">CSV file only</p>
      </div>
    )}
  </div>
);

export default UploadArea;
