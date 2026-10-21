/** Projects navigation opens the shared panel from desktop rail or mobile drawer. */
import { FolderGit2 } from 'lucide-react';
import { useRoseApps } from '../rose-apps/roseAppsState';
import { RoseNavRow } from './RoseSidebarChrome';

export function ProjectsNavButton({
  isExpanded,
  onOpen,
}: {
  isExpanded: boolean;
  onOpen?: () => void;
}) {
  const apps = useRoseApps();
  if (!apps) return null;
  return (
    <RoseNavRow
      icon={<FolderGit2 className="h-5 w-5" strokeWidth={1.7} />}
      label="Projects"
      isExpanded={isExpanded}
      isActive={apps.openApp === 'projects'}
      onClick={() => {
        apps.toggleApp('projects');
        onOpen?.();
      }}
    />
  );
}
