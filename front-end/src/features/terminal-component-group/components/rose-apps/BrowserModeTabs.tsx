import { Cloud, Monitor } from 'lucide-react';
import { useRoseApps } from './roseAppsState';

export function BrowserModeTabs() {
  const apps = useRoseApps();
  if (apps === null) return null;
  return (
    <div role="group" aria-label="Browser mode" className="flex flex-none items-center gap-1">
      {(['local', 'remote'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-label={mode === 'local' ? 'Local' : 'Remote'}
          title={
            mode === 'local'
              ? 'Local preview: View the app running in your agent’s code workspace.'
              : 'Remote browser: View and control the browser used by this agent.'
          }
          aria-pressed={apps.browserMode === mode}
          tabIndex={apps.browserMode === mode ? 0 : -1}
          onClick={() => apps.setBrowserMode(mode)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === 'Home'
                ? 'local'
                : event.key === 'End'
                  ? 'remote'
                  : mode === 'local'
                    ? 'remote'
                    : 'local';
            apps.setBrowserMode(next);
            const buttons =
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button');
            buttons?.[next === 'local' ? 0 : 1]?.focus();
          }}
          className={`grid h-7 w-7 place-items-center rounded-md ${apps.browserMode === mode ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
        >
          {mode === 'local' ? (
            <Monitor className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Cloud className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      ))}
    </div>
  );
}
