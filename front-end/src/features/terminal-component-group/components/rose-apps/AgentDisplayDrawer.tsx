/** A single active output frame, mounted only while Agent Display is open. */
import { DisplayMediaGroup } from '../inline-media/DisplayMediaGroup';
import { AppDrawerShell } from './AppDrawerShell';
import { shownDisplayEntry } from './agentDisplayEntries';
import { useRoseApps } from './roseAppsState';

export function AgentDisplayDrawer() {
  const apps = useRoseApps();
  if (!apps) return null;
  const open = apps.openApp === 'display';
  const entries = apps.displayEntries.filter((entry) => entry.agentId === apps.selectedAgentId);
  const chosen = shownDisplayEntry(apps);
  return (
    <AppDrawerShell open={open} label="Agent Display" testId="agent-display-drawer" variant="full">
      <div
        data-testid="agent-display-header"
        className="flex h-[56px] flex-none items-center px-[18px] pr-12 md:pr-56 text-sm font-semibold"
      >
        Agent Display
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="agent-display-content">
          {!chosen ? (
            <p className="text-sm text-muted-foreground">
              {apps.selectedAgentId
                ? 'No displays yet for this agent.'
                : 'Select an agent to see its displays.'}
            </p>
          ) : (
            <>
              {entries.length > 1 && (
                <label className="mb-4 flex items-center gap-2 text-sm">
                  Output
                  <select
                    aria-label="Display output"
                    value={chosen.id}
                    className="min-w-0 rounded border border-border bg-background p-2 text-foreground"
                    onChange={(event) =>
                      apps.selectDisplay({ agentId: chosen.agentId, id: event.target.value })
                    }
                  >
                    {entries.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.items[0]?.caption ||
                          entry.items[0]?.file.original_filename ||
                          'Display'}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <DisplayMediaGroup
                key={`${chosen.agentId}:${chosen.id}`}
                items={chosen.items}
                agentId={chosen.agentId}
              />
            </>
          )}
        </div>
      )}
    </AppDrawerShell>
  );
}
