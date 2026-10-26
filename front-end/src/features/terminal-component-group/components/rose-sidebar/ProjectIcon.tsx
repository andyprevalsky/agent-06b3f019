/**
 * STATE MACHINE: ProjectIcon (Rose project row icon, UI item 32)
 *
 *   repoUrl without a GitHub owner (none, other host, unparseable) --> [FOLDER]
 *   GitHub owner, URL not known to fail --> [AVATAR] <img> owner avatar
 *   [AVATAR] --img error--> [FOLDER]; the URL is remembered as failed for this
 *                           page load, so remounts (bar collapse/expand) never retry
 *
 * Same 20px box as the folder, a square with modest rounding; decorative
 * (alt=""), the row's text names the project. One stable URL per owner, so the
 * browser cache serves every row and surface; no polling or API calls.
 */

import { Folder } from 'lucide-react';
import { useState } from 'react';

import { githubOwnerAvatarUrl, githubRepoOwner } from './githubRepoOwner';

const FAILED_AVATAR_URLS = new Set<string>();

function OwnerAvatar({ src }: { src: string }) {
  const [failed, setFailed] = useState(() => FAILED_AVATAR_URLS.has(src));
  if (failed) return <Folder className="h-5 w-5 flex-none" strokeWidth={1.7} />;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => {
        FAILED_AVATAR_URLS.add(src);
        setFailed(true);
      }}
      className="h-5 w-5 flex-none rounded-[4px] object-cover"
    />
  );
}

export default function ProjectIcon({ repoUrl }: { repoUrl: string | null }) {
  const owner = githubRepoOwner(repoUrl);
  if (owner === null) return <Folder className="h-5 w-5 flex-none" strokeWidth={1.7} />;
  const src = githubOwnerAvatarUrl(owner);
  // Keyed by URL: an edited repo gets a fresh load attempt for its new owner.
  return <OwnerAvatar key={src} src={src} />;
}
