import { useEffect } from "react";

// Always downloads the latest release (filename is version-agnostic)
const DOWNLOAD_URL = "https://github.com/andyprevalsky/navi-whisper-lux/releases/latest/download/Rose-mac.dmg";

export default function Download() {
  useEffect(() => {
    // Trigger download immediately
    window.location.href = DOWNLOAD_URL;
  }, []);

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center">
      <p className="text-neutral-400">Starting download...</p>
    </div>
  );
}
