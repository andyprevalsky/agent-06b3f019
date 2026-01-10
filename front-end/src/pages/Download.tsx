/**
 * STATE MACHINE: Download
 *
 * This component is stateless - displays a static "Coming Soon" message.
 *
 * [MOUNTED] --> renders static content
 */

// import { useEffect } from "react";

// Always downloads the latest release (filename is version-agnostic)
// const DOWNLOAD_URL = "https://github.com/andyprevalsky/navi-whisper-lux/releases/latest/download/Rose-mac.dmg";

export default function Download() {
  // useEffect(() => {
  //   // Trigger download immediately
  //   window.location.href = DOWNLOAD_URL;
  // }, []);

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-semibold mb-2">Mac App Coming Soon</h1>
        <p className="text-neutral-400">Check back soon!</p>
      </div>
    </div>
  );
}
