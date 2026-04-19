import { useState, useEffect, useRef } from 'react';
import { ArrowRight, ArrowUp } from 'lucide-react';
import { liquidMetalFragmentShader, ShaderMount } from '@paper-design/shaders';
import LiquidWhiteButton from '@/components/ui/liquid-white-button';

interface ShortcutConfig {
  modifiers: string[];
  key: string;
}

interface OnboardingShortcutProps {
  onComplete: () => void;
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

// Quick Launcher preview shader
const LauncherShaderTile = ({ size }: { size: number }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const shaderRef = useRef<ShaderMount | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (shaderRef.current !== null) {
      shaderRef.current.dispose();
      shaderRef.current = null;
    }

    shaderRef.current = new ShaderMount(
      container,
      liquidMetalFragmentShader,
      {
        u_repetition: 0.5,
        u_softness: 0.8,
        u_shiftRed: 0.15,
        u_shiftBlue: 0.15,
        u_distortion: 0,
        u_contour: 0,
        u_angle: 90,
        u_scale: 1.5,
        u_shape: 0,
        u_offsetX: 0,
        u_offsetY: 0,
      },
      undefined,
      0.5
    );

    return () => {
      if (shaderRef.current !== null) {
        shaderRef.current.dispose();
        shaderRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%',
        height: size,
        maskImage:
          'linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0) 100%)',
        WebkitMaskImage:
          'linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0) 100%)',
        pointerEvents: 'none',
      }}
    />
  );
};

// Quick Launcher preview component
const QuickLauncherPreview = () => {
  return (
    <div style={{ position: 'relative', width: '100%', height: 52 }}>
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: 9999,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15), 0 2px 4px rgba(0, 0, 0, 0.1)',
        }}
      >
        {/* Shader background */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 9999,
            overflow: 'hidden',
          }}
        >
          <LauncherShaderTile size={52} />
        </div>

        {/* Inner content */}
        <div
          style={{
            position: 'absolute',
            top: 2,
            left: 2,
            right: 2,
            bottom: 2,
            borderRadius: 9999,
            backgroundColor: '#f5f5f5',
            display: 'flex',
            alignItems: 'center',
            paddingLeft: 16,
            paddingRight: 4,
            gap: 12,
          }}
        >
          <span
            style={{
              flex: 1,
              fontSize: 13,
              color: 'rgba(39, 39, 37, 0.5)',
            }}
          >
            Enter any desire
          </span>

          <LiquidWhiteButton disabled size="sm">
            <ArrowUp className="w-5 h-5" strokeWidth={2.5} />
          </LiquidWhiteButton>
        </div>
      </div>
    </div>
  );
};

// Convert e.code to a readable key name
const codeToKey = (code: string): string => {
  if (code.startsWith('Key')) {
    return code.slice(3);
  }
  if (code.startsWith('Digit')) {
    return code.slice(5);
  }
  const codeMap: Record<string, string> = {
    Space: 'Space',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    Enter: 'Enter',
    Escape: 'Escape',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
  };
  return codeMap[code] || code;
};

const MODIFIER_KEY_CODES = new Set([
  'MetaLeft',
  'MetaRight',
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
]);

const extractShortcutFromEvent = (e: KeyboardEvent): ShortcutConfig | null => {
  if (MODIFIER_KEY_CODES.has(e.code)) return null;
  const modifiers: string[] = [];
  if (e.metaKey) modifiers.push('Meta');
  if (e.altKey) modifiers.push('Alt');
  if (e.ctrlKey) modifiers.push('Control');
  if (e.shiftKey) modifiers.push('Shift');
  if (modifiers.length === 0) return null;
  return { modifiers, key: codeToKey(e.code) };
};

const loadSavedShortcut = async (): Promise<ShortcutConfig | null> => {
  if (!window.api?.shortcut?.get) return null;
  try {
    const saved = await window.api.shortcut.get();
    if (saved) return saved;
    await window.api.shortcut.set(DEFAULT_SHORTCUT);
    return null;
  } catch (err) {
    console.error('Failed to load shortcut config:', err);
    return null;
  }
};

const persistShortcut = async (config: ShortcutConfig): Promise<void> => {
  if (!window.api?.shortcut?.set) return;
  try {
    await window.api.shortcut.set(config);
  } catch (err) {
    console.error('Failed to save shortcut:', err);
  }
};

const OnboardingShortcut = ({ onComplete }: OnboardingShortcutProps) => {
  const [shortcut, setShortcut] = useState<ShortcutConfig>(DEFAULT_SHORTCUT);
  const [isRecording, setIsRecording] = useState(false);
  const isRecordingRef = useRef(isRecording);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    void loadSavedShortcut().then((saved) => {
      if (saved) setShortcut(saved);
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isRecordingRef.current) return;
      const newShortcut = extractShortcutFromEvent(e);
      if (!newShortcut) return;
      e.preventDefault();
      e.stopPropagation();
      setShortcut(newShortcut);
      setIsRecording(false);
      void persistShortcut(newShortcut);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-80px)] px-8">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-foreground mb-2">Quick Launcher</h1>
        <p className="text-muted-foreground mb-6">
          Set a keyboard shortcut to quickly summon Rose from anywhere
        </p>

        <div className="mb-6">
          <QuickLauncherPreview />
        </div>

        <div className="mb-8">
          <button
            onClick={() => setIsRecording(true)}
            className={`w-full px-6 py-6 rounded-xl border-2 text-center transition-colors ${
              isRecording
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-foreground/30'
            }`}
          >
            {isRecording ? (
              <span className="text-sm text-muted-foreground block">Press modifier + key...</span>
            ) : (
              <span className="font-mono text-2xl text-foreground block">
                {formatShortcut(shortcut)}
              </span>
            )}
            {!isRecording && (
              <span className="text-xs text-muted-foreground mt-2 block">click to change</span>
            )}
          </button>
        </div>

        <button
          onClick={onComplete}
          className="w-full py-4 px-4 rounded-xl bg-foreground text-background font-medium text-base hover:bg-foreground/90 transition-colors flex items-center justify-center gap-2"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default OnboardingShortcut;
