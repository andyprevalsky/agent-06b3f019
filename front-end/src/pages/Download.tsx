/**
 * STATE MACHINE: Download
 *
 * This component triggers an automatic download redirect on mount.
 *
 * [MOUNTED] --> redirect to Supabase Storage download URL
 */

import { useEffect } from 'react';

// Always downloads the latest release from Supabase Storage (public bucket)
const DOWNLOAD_URL =
  'https://kzlurqihzaolhzsbkctf.supabase.co/storage/v1/object/public/Releases/mac/latest/Rose-mac.dmg';

export default function Download() {
  useEffect(() => {
    // Trigger download immediately
    window.location.href = DOWNLOAD_URL;
  }, []);

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-semibold mb-2">Downloading Rose for Mac...</h1>
        <p className="text-neutral-400">
          If download doesn't start,{' '}
          <a href={DOWNLOAD_URL} className="underline">
            click here
          </a>
          .
        </p>
      </div>
    </div>
  );
}
