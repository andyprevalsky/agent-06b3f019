/**
 * Full-screen image preview portaled to `document.body`.
 *
 * STATE MACHINE: open (lifecycle managed by parent) -> close on Esc / backdrop / X button.
 * Download button fires the onDownload callback (parent owns the blob fetch).
 */
import { memo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Download } from 'lucide-react';

interface ImageLightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
  onDownload: () => void;
}

export const ImageLightbox = memo(function ImageLightbox({
  src,
  alt,
  onClose,
  onDownload,
}: ImageLightboxProps) {
  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} className="max-w-full max-h-[90vh] object-contain rounded-lg" />
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-2 right-2 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
        {/* Download button */}
        <button
          onClick={onDownload}
          className="absolute bottom-2 right-2 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
        >
          <Download className="w-5 h-5" />
        </button>
      </div>
    </div>,
    document.body,
  );
});
