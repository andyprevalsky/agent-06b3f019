/**
 * STATE MACHINE: Download
 *
 * This component triggers an automatic download redirect on mount.
 *
 * [MOUNTED] --> track automatic start --> redirect to Supabase Storage URL
 * [FALLBACK_CLICK] --> track fallback start --> browser follows download link
 */

import { DOWNLOAD_URL } from '../config';
import { trackDownloadStarted, useDownloadRedirect } from '../hooks';

export default function Download() {
  useDownloadRedirect();

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-semibold mb-2">Downloading Rose for Mac...</h1>
        <p className="text-neutral-400">
          If download doesn't start,{' '}
          <a
            href={DOWNLOAD_URL}
            className="underline"
            onClick={() => trackDownloadStarted('fallback_link')}
          >
            click here
          </a>
          .
        </p>
      </div>
    </div>
  );
}
