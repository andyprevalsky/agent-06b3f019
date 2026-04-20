/**
 * Fullscreen lightbox that enlarges the Passwords-app export screenshot.
 * Clicking anywhere on the backdrop closes it — there is no close button.
 */

import passwordsExportStep from '../../../assets/passwords-export-step.png';
import { EXPORT_HIGHLIGHT_STYLE } from '../config';

interface LightboxProps {
  onClose: () => void;
}

const Lightbox = ({ onClose }: LightboxProps): React.ReactElement => (
  <div
    className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 cursor-zoom-out"
    onClick={onClose}
  >
    <div className="relative">
      <img
        src={passwordsExportStep}
        alt="Passwords app showing File menu with Export option"
        className="max-w-[90vw] max-h-[90vh] rounded-lg"
      />
      <div
        className="absolute border-2 border-red-500 rounded pointer-events-none"
        style={EXPORT_HIGHLIGHT_STYLE}
      />
    </div>
  </div>
);

export default Lightbox;
