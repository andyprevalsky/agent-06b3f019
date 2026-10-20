/**
 * Text formatting for the Rose Desktop sync progress bar (SyncProgressBar.tsx).
 * Kept out of the component module so that file only exports components
 * (react-refresh/only-export-components).
 */

/** "45 s", "4 min", "1 h 5 min". */
export function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.max(seconds, 1)} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'];

/** "512 B", "1.5 MB", "24 MB" (decimal units, as macOS Finder shows sizes). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.max(Math.round(bytes), 0)} B`;
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 999.5 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const text = value < 9.95 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${text} ${BYTE_UNITS[unit]}`;
}

/**
 * Readable text for a provider's raw sync phase. Gmail, LinkedIn and WhatsApp
 * report machine phases (`scanning`, `waiting_for_export`, ...); every other provider
 * already reports user-facing text, which is shown unchanged.
 */
const PHASE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  gmail: {
    scanning: 'Scanning mailbox',
    saving: 'Saving messages',
    history: 'Checking for new mail',
  },
  linkedin: {
    starting: 'Starting export',
    export_requested: 'Export requested',
    waiting_for_export: 'Waiting for LinkedIn to prepare the export',
    uploading: 'Uploading archive',
    parsing: 'Reading archive',
  },
  whatsapp: {
    initial_bootstrap: 'Linking device',
    recent: 'Syncing recent chats',
    full: 'Syncing full history',
    push_name: 'Updating contact names',
    on_demand: 'Loading older messages',
  },
};

export function phaseLabel(provider: string, phase: string | null): string | null {
  if (phase === null) return null;
  return PHASE_LABELS[provider]?.[phase] ?? phase;
}
