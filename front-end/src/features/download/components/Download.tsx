/**
 * STATE MACHINE: Download
 *
 * This component triggers an automatic download redirect on mount.
 *
 * [MOUNTED] --> redirect to Supabase Storage download URL
 */

import { DOWNLOAD_URL } from '../config';
import { useDownloadRedirect } from '../hooks';

export default function Download() {
  useDownloadRedirect();

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
