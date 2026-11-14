import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { ConnectedGithubRepo } from '../../hooks';
import { INHERIT_GITHUB_REPO } from './useGithubRepoSelection';

const INHERIT_LABEL = 'Project default (inherited)';

interface GithubRepoSelectProps {
  repos: ConnectedGithubRepo[];
  value: string;
  onChange: (ref: string) => void;
  loadError: string | null;
  error: string | null;
}

/** Connected GitHub repo for the new agent's code sessions; an explicit pick wins over the inherited one. */
export function GithubRepoSelect({
  repos,
  value,
  onChange,
  loadError,
  error,
}: GithubRepoSelectProps) {
  const selected = repos.find((repo) => repo.canonical_ref === value);
  const triggerLabel =
    value === INHERIT_GITHUB_REPO ? INHERIT_LABEL : (selected?.repo_name ?? value);

  return (
    <div className="space-y-2">
      <Label htmlFor="github-repo">GitHub Repo</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id="github-repo"
            variant="outline"
            role="combobox"
            aria-invalid={error !== null}
            className={cn(
              'w-full justify-between bg-background dark:bg-navi-light-black border-border',
              error !== null && 'border-destructive',
            )}
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="p-0 bg-card dark:bg-navi-black border-border"
          align="start"
          style={{ width: 'var(--radix-popover-trigger-width)' }}
        >
          <Command className="bg-transparent">
            <CommandList className="max-h-64">
              <CommandGroup>
                <RepoRow
                  label={INHERIT_LABEL}
                  detail="The connected project's repo, if any"
                  isSelected={value === INHERIT_GITHUB_REPO}
                  onSelect={() => onChange(INHERIT_GITHUB_REPO)}
                />
                {repos.map((repo) => (
                  <RepoRow
                    key={repo.canonical_ref}
                    label={repo.repo_name}
                    detail={repo.canonical_ref}
                    isSelected={value === repo.canonical_ref}
                    onSelect={() => onChange(repo.canonical_ref)}
                  />
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
      {error === null && loadError !== null && (
        <p className="text-xs text-muted-foreground">{loadError}</p>
      )}
    </div>
  );
}

function RepoRow({
  label,
  detail,
  isSelected,
  onSelect,
}: {
  label: string;
  detail: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={`${label} ${detail}`} onSelect={onSelect} className="cursor-pointer">
      <Check className={cn('mr-2 h-4 w-4 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')} />
      <div className="flex flex-col flex-1 min-w-0 gap-0.5">
        <span className="truncate">{label}</span>
        <span className="text-[10px] text-muted-foreground truncate">{detail}</span>
      </div>
    </CommandItem>
  );
}
