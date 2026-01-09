import { useState, useEffect, useCallback } from 'react';
import { Check, Keyboard } from 'lucide-react';

interface ShortcutConfig {
  modifiers: string[];
  key: string;
}

interface ShortcutConfiguratorProps {
  disabled?: boolean;
}

const DEFAULT_SHORTCUT: ShortcutConfig = {
  modifiers: ['Alt'],
  key: 'Space',
};

const MODIFIER_DISPLAY: Record<string, string> = {
  Meta: '\u2318', // Command
  Alt: '\u2325', // Option
  Control: '\u2303', // Control
  Shift: '\u21E7', // Shift
};

const KEY_DISPLAY: Record<string, string> = {
  Space: 'Space',
  ArrowUp: '\u2191',
  ArrowDown: '\u2193',
  ArrowLeft: '\u2190',
  ArrowRight: '\u2192',
  Enter: '\u23CE',
  Escape: 'Esc',
  Tab: '\u21E5',
  Backspace: '\u232B',
};

const formatShortcut = (config: ShortcutConfig): string => {
  const mods = config.modifiers.map((m) => MODIFIER_DISPLAY[m] || m).join(' ');
  const key = KEY_DISPLAY[config.key] || config.key.toUpperCase();
  return `${mods} ${key}`.trim();
};

const ShortcutConfigurator = ({ disabled }: ShortcutConfiguratorProps) => {
  const [shortcut, setShortcut] = useState<ShortcutConfig>(DEFAULT_SHORTCUT);
  const [isRecording, setIsRecording] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  // Load saved shortcut on mount
  useEffect(() => {
    const loadShortcut = async () => {
      if (window.api?.shortcut?.get) {
        try {
          const saved = await window.api.shortcut.get();
          if (saved) {
            setShortcut(saved);
          }
        } catch (err) {
          console.error('Failed to load shortcut config:', err);
        }
      }
    };
    loadShortcut();
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isRecording || disabled) return;

      e.preventDefault();
      e.stopPropagation();

      // Collect modifiers
      const modifiers: string[] = [];
      if (e.metaKey) modifiers.push('Meta');
      if (e.altKey) modifiers.push('Alt');
      if (e.ctrlKey) modifiers.push('Control');
      if (e.shiftKey) modifiers.push('Shift');

      // Ignore if only modifiers pressed
      const isModifierKey = ['Meta', 'Alt', 'Control', 'Shift'].includes(e.key);
      if (isModifierKey) return;

      // Must have at least one modifier
      if (modifiers.length === 0) return;

      const newShortcut: ShortcutConfig = {
        modifiers,
        key: e.code === 'Space' ? 'Space' : e.key,
      };

      setShortcut(newShortcut);
      setIsRecording(false);

      // Save the shortcut
      saveShortcut(newShortcut);
    },
    [isRecording, disabled]
  );

  const saveShortcut = async (config: ShortcutConfig) => {
    if (window.api?.shortcut?.set) {
      try {
        await window.api.shortcut.set(config);
        setIsSaved(true);
        setTimeout(() => setIsSaved(false), 2000);
      } catch (err) {
        console.error('Failed to save shortcut:', err);
      }
    }
  };

  useEffect(() => {
    if (isRecording) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isRecording, handleKeyDown]);

  const handleStartRecording = () => {
    if (disabled) return;
    setIsRecording(true);
  };

  const handleResetToDefault = () => {
    setShortcut(DEFAULT_SHORTCUT);
    saveShortcut(DEFAULT_SHORTCUT);
  };

  return (
    <div
      className={`p-4 rounded-xl border transition-all duration-200 ${
        disabled
          ? 'bg-muted/30 border-border/50 opacity-60'
          : isRecording
          ? 'bg-primary/5 border-primary/30'
          : 'bg-card border-border'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Keyboard className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            Quick Launcher Shortcut
          </span>
        </div>
        {isSaved && (
          <span className="flex items-center gap-1 text-xs text-green-600">
            <Check className="w-3 h-3" />
            Saved
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {/* Shortcut display */}
        <button
          onClick={handleStartRecording}
          disabled={disabled}
          className={`flex-1 px-4 py-3 rounded-lg border-2 border-dashed font-mono text-lg text-center transition-all duration-200 ${
            isRecording
              ? 'border-primary bg-primary/5 text-primary animate-pulse'
              : disabled
              ? 'border-border/50 text-muted-foreground cursor-not-allowed'
              : 'border-border text-foreground hover:border-primary/30 cursor-pointer'
          }`}
        >
          {isRecording ? 'Press your shortcut...' : formatShortcut(shortcut)}
        </button>

        {/* Reset button */}
        <button
          onClick={handleResetToDefault}
          disabled={disabled || isRecording}
          className="px-3 py-2 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-surface transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Reset
        </button>
      </div>

      <p className="text-xs text-muted-foreground mt-3">
        Press any modifier key (Cmd, Option, Ctrl, Shift) + another key
      </p>
    </div>
  );
};

export default ShortcutConfigurator;
