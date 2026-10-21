import { useRoseApps } from './roseAppsState';

export function BrowserModeTabs() {
  const apps = useRoseApps();
  if (apps === null) return null;
  return (
    <div
      role="tablist"
      aria-label="Browser mode"
      className="flex flex-none gap-4 border-b border-border px-[18px] text-sm"
    >
      {(['local', 'remote'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          role="tab"
          aria-selected={apps.browserMode === mode}
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
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]',
              );
            buttons?.[next === 'local' ? 0 : 1]?.focus();
          }}
          className={`border-b-2 py-2 capitalize ${apps.browserMode === mode ? 'border-current font-semibold text-foreground' : 'border-transparent text-muted-foreground'}`}
        >
          {mode === 'local' ? 'Local' : 'Remote'}
        </button>
      ))}
    </div>
  );
}
