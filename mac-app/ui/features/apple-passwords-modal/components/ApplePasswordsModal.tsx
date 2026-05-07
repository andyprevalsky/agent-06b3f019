/**
 * ApplePasswordsModal — guides the user through exporting Apple Passwords
 * to a CSV and handing the file to the parent via `onSync`.
 *
 * State machine (see hooks.ts for the orchestrator):
 *   closed (isOpen=false) ──(isOpen=true)──▶ idle
 *   idle ──(pick .csv)──▶ fileSelected
 *   idle ──(pick non-.csv)──▶ error(idle)
 *   fileSelected ──(Import + onSync resolves)──▶ loading (parent closes)
 *   fileSelected ──(Import + onSync rejects)──▶ error(fileSelected)
 *   * (not loading) ──(Cancel | backdrop | X)──▶ closed (reset)
 *   loading ──(any close attempt)──▶ loading (no-op; controls disabled)
 *
 * This component is a thin renderer over `useApplePasswordsModal`; no IPC
 * wiring or business logic lives here.
 */

import { Loader2, ShieldCheck, X } from 'lucide-react';
import { useApplePasswordsModal } from '../hooks';
import type { ApplePasswordsModalProps } from '../types';
import Instructions from './Instructions';
import Lightbox from './Lightbox';
import UploadArea from './UploadArea';

const ModalHeader = ({
  loading,
  onClose,
}: {
  loading: boolean;
  onClose: () => void;
}): React.ReactElement => (
  <div className="flex items-center justify-between px-5 py-4 border-b border-border">
    <div className="flex items-center gap-2">
      <ShieldCheck className="w-4 h-4 text-muted-foreground" />
      <h2 className="text-base font-semibold text-foreground">Import Apple Passwords</h2>
    </div>
    <button
      onClick={onClose}
      disabled={loading}
      className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
    >
      <X className="w-4 h-4" />
    </button>
  </div>
);

const SecurityNotice = (): React.ReactElement => (
  <div className="flex items-start gap-2 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
    <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
    <div className="text-xs text-emerald-800 dark:text-emerald-200">
      <span className="font-medium">Your passwords are encrypted end-to-end.</span> They are
      encrypted using RSA-2048 and can only be decrypted by Rose's secure workers. The CSV never
      touches our servers in plaintext.
    </div>
  </div>
);

interface FooterProps {
  loading: boolean;
  canImport: boolean;
  onClose: () => void;
  onImport: () => void;
}

const ModalFooter = ({
  loading,
  canImport,
  onClose,
  onImport,
}: FooterProps): React.ReactElement => (
  <div className="flex justify-end gap-2 px-5 py-4 border-t border-border bg-muted/30">
    <button
      onClick={onClose}
      disabled={loading}
      className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
    >
      Cancel
    </button>
    <button
      onClick={onImport}
      disabled={loading || !canImport}
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
);

const ApplePasswordsModal = ({
  isOpen,
  onClose,
  onSync,
}: ApplePasswordsModalProps): React.ReactElement | null => {
  const state = useApplePasswordsModal(onClose, onSync);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={state.onCloseClick} />

      <div className="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-xl mx-4 overflow-hidden max-h-[90vh] overflow-y-auto">
        <ModalHeader loading={state.loading} onClose={state.onCloseClick} />

        <div className="px-5 py-4 space-y-4">
          <Instructions
            onOpenPasswords={state.onOpenPasswordsClick}
            onExpandScreenshot={() => state.setExpandedImage(true)}
          />

          <UploadArea
            file={state.file}
            isDragOver={state.isDragOver}
            fileInputRef={state.fileInputRef}
            onFileInputChange={state.onFileInputChange}
            onDragOver={state.onDragOver}
            onDragLeave={state.onDragLeave}
            onDrop={state.onDrop}
          />

          <SecurityNotice />

          {state.error !== null && <p className="text-sm text-red-500">{state.error}</p>}
        </div>

        <ModalFooter
          loading={state.loading}
          canImport={state.file !== null}
          onClose={state.onCloseClick}
          onImport={() => void state.onSyncClick()}
        />
      </div>

      {state.expandedImage && <Lightbox onClose={() => state.setExpandedImage(false)} />}
    </div>
  );
};

export default ApplePasswordsModal;
