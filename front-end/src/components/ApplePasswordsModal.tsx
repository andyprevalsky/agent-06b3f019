import { useState, useRef } from 'react';
import { X, Loader2, Upload, ShieldCheck, FileText, ExternalLink, Trash2 } from 'lucide-react';
import passwordsExportStep from '@/assets/passwords-export-step.png';

interface ApplePasswordsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSync: (file: File) => Promise<void>;
}

/**
 * Modal for importing Apple Passwords via CSV export.
 *
 * Guides users through:
 * 1. Opening the Passwords app
 * 2. Exporting passwords to CSV
 * 3. Uploading the CSV file
 * 4. Deleting the local file for security
 */
const ApplePasswordsModal = ({ isOpen, onClose, onSync }: ApplePasswordsModalProps) => {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [expandedImage, setExpandedImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleFileChange = (selectedFile: File | null) => {
    if (selectedFile) {
      if (!selectedFile.name.endsWith('.csv')) {
        setError('Please select a CSV file');
        return;
      }
      setFile(selectedFile);
      setError(null);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    handleFileChange(droppedFile);
  };

  const handleSync = async () => {
    if (!file) {
      setError('Please select a CSV file');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await onSync(file);
      // Success - modal will be closed by parent
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import passwords');
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setFile(null);
      setError(null);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-xl mx-4 overflow-hidden max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-base font-semibold text-foreground">Import Apple Passwords</h2>
          </div>
          <button
            onClick={handleClose}
            disabled={loading}
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4">
          <ol className="text-sm text-muted-foreground space-y-4">
            {/* Step 1: Open Passwords app */}
            <li className="space-y-2">
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">1</span>
                <div className="flex-1">
                  <span>Open the <strong className="text-foreground">Passwords</strong> app on your Mac</span>
                  <p className="text-xs text-muted-foreground mt-1">
                    Search for "Passwords" in Spotlight (Cmd + Space)
                  </p>
                </div>
              </div>
            </li>

            {/* Step 2: Export passwords */}
            <li className="space-y-2">
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">2</span>
                <span>
                  Click <strong className="text-foreground">File</strong> → <strong className="text-foreground">Export All Passwords to File...</strong>
                </span>
              </div>
              <div className="flex justify-center mt-2">
                <button
                  onClick={() => setExpandedImage(true)}
                  className="cursor-zoom-in relative group"
                >
                  <img
                    src={passwordsExportStep}
                    alt="Passwords app showing File menu with Export option"
                    className="rounded-lg border border-border max-w-[300px]"
                  />
                  {/* Red highlight box on "Export All Passwords to File..." */}
                  <div
                    className="absolute border-2 border-red-500 rounded pointer-events-none"
                    style={{
                      top: '69%',
                      left: '34%',
                      width: '55%',
                      height: '10%',
                    }}
                  />
                  <span className="absolute bottom-2 right-2 text-xs bg-black/60 text-white px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity">
                    Click to enlarge
                  </span>
                </button>
              </div>
            </li>

            {/* Step 3: Upload the CSV */}
            <li className="space-y-2">
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">3</span>
                <span>Save the file and <strong className="text-foreground">upload it below</strong></span>
              </div>
            </li>

            {/* Step 4: Delete local file */}
            <li className="space-y-2">
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium">4</span>
                <div className="flex items-center gap-2">
                  <Trash2 className="w-4 h-4 text-muted-foreground" />
                  <span><strong className="text-foreground">Delete the CSV file</strong> from your computer after import</span>
                </div>
              </div>
            </li>
          </ol>

          {/* File upload area */}
          <div
            className={`relative border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
              isDragOver
                ? 'border-primary bg-primary/5'
                : file
                ? 'border-green-500 bg-green-500/5'
                : 'border-border hover:border-primary/50'
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
            />

            {file ? (
              <div className="flex flex-col items-center gap-2">
                <FileText className="w-8 h-8 text-green-600 dark:text-green-400" />
                <p className="text-sm font-medium text-foreground">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  Click or drag to replace
                </p>
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

          {/* Security notice */}
          <div className="flex items-start gap-2 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-emerald-800 dark:text-emerald-200">
              <span className="font-medium">Your passwords are encrypted end-to-end.</span>{' '}
              They are encrypted using RSA-2048 and can only be decrypted by Rose's secure workers. The CSV never touches our servers in plaintext.
            </div>
          </div>

          {/* Error message */}
          {error && (
            <p className="text-sm text-red-500">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border bg-muted/30">
          <button
            onClick={handleClose}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSync}
            disabled={loading || !file}
            className="px-4 py-2 text-sm font-medium bg-foreground text-background rounded-lg hover:bg-foreground/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Importing...
              </>
            ) : (
              'Import Passwords'
            )}
          </button>
        </div>
      </div>

      {/* Image lightbox */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 cursor-zoom-out"
          onClick={() => setExpandedImage(false)}
        >
          <div className="relative">
            <img
              src={passwordsExportStep}
              alt="Passwords app showing File menu with Export option"
              className="max-w-[90vw] max-h-[90vh] rounded-lg"
            />
            {/* Red highlight box on "Export All Passwords to File..." */}
            <div
              className="absolute border-2 border-red-500 rounded pointer-events-none"
              style={{
                top: '69%',
                left: '34%',
                width: '55%',
                height: '10%',
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default ApplePasswordsModal;
