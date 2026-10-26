/**
 * STATE MACHINE: FileSystemSection
 *
 * System context:
 *   Integrations page -> IntegrationSections -> FileSystemSection
 *
 *   [WEB]     --> Desktop Only + Download for Mac
 *   [MAC_APP] --plus click--> [MAC_APP]
 *
 * FE-only placeholder for cloud file sync. Website points users at the Mac
 * download. The Mac app shows the same plus as other connect actions, but the
 * click stays idle (no API, no modal).
 */

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

import DropdownIconFrame, { DropdownIconPreset } from './DropdownIconFrame';

interface FileSystemSectionProps {
  isAvailable: boolean;
}

export function FileSystemIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="fileSystemGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#14b8a6" />
          <stop offset="100%" stopColor="#0ea5e9" />
        </linearGradient>
      </defs>
      <path
        d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.2c.4 0 .8.16 1.1.44L12.1 7H18a2.5 2.5 0 0 1 2.5 2.5V18A2.5 2.5 0 0 1 18 20.5H6A2.5 2.5 0 0 1 3.5 18V7.5z"
        fill="url(#fileSystemGradient)"
      />
    </svg>
  );
}

function noopFileSystemConnect(): void {
  return undefined;
}

function FileSystemDesktopOnlyFallback() {
  return (
    <div className="flex items-center justify-between flex-wrap gap-2 p-4 border border-border rounded-lg bg-card/60">
      <div className="flex items-center gap-3">
        <DropdownIconFrame {...DropdownIconPreset.fileSystem}>
          <FileSystemIcon />
        </DropdownIconFrame>
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">File System</h3>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              Desktop Only
            </span>
          </div>
          <span className="text-xs text-muted-foreground">Sync your files to the cloud</span>
        </div>
      </div>
      <Button size="sm" variant="outline" asChild>
        <a href="/download">Download for Mac</a>
      </Button>
    </div>
  );
}

export default function FileSystemSection({ isAvailable }: FileSystemSectionProps) {
  if (!isAvailable) {
    return <FileSystemDesktopOnlyFallback />;
  }

  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <DropdownIconFrame {...DropdownIconPreset.fileSystem}>
            <FileSystemIcon />
          </DropdownIconFrame>
          <div className="flex min-w-0 flex-col">
            <h3 className="truncate font-medium">File System</h3>
            <span className="truncate text-xs text-muted-foreground">
              Sync your files to the cloud
            </span>
          </div>
        </div>
        <button
          type="button"
          aria-label="Connect File System"
          onClick={noopFileSystemConnect}
          className="h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
