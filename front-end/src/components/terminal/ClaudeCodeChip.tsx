/**
 * STATE MACHINE: ClaudeCodeChip
 *
 * EXPANSION STATE:
 * [COLLAPSED] <-- isExpanded: false
 *     |
 *     v
 * [EXPANDED] <-- isExpanded: true (shows terminal output)
 *
 * FULLSCREEN STATE:
 * [NORMAL] <-- isFullscreen: false
 *     |
 *     v
 * [FULLSCREEN] <-- isFullscreen: true (renders via portal)
 *
 * TERMINAL STATE:
 * [IDLE] --> terminalReady: false
 *     |
 *     v (xterm initialized)
 * [READY] --> terminalReady: true
 *     |
 *     +--> terminal output streams via realtime subscription
 *
 * States:
 * - isExpanded: boolean
 * - isFullscreen: boolean
 * - terminalReady: boolean
 * - xterm Terminal instance (via ref)
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { CheckCircle2, XCircle, Loader2, ChevronDown, ChevronUp, Maximize2, X, FileJson, FileIcon, Download, ExternalLink } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Terminal as XTermTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { cn } from '@/lib/utils';
import { useAgentContext } from '@/contexts/AgentContext';
import { ResponseSchemaField, FilePointer } from '@/lib/api';
import ClaudeIcon from '@/assets/claude-color.svg';
import { supabase, getSession } from '@/lib/supabase';

const API_URL = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '');

// Format field type for display
function formatFieldType(type: ResponseSchemaField['type']): string {
  switch (type) {
    case 'str': return 'string';
    case 'int': return 'integer';
    case 'float': return 'number';
    case 'bool': return 'boolean';
    case 'list[str]': return 'string[]';
    case 'list[int]': return 'integer[]';
    case 'file_pointer': return 'file';
    case 'list[file_pointer]': return 'file[]';
    default: return type;
  }
}

// Check if a value looks like a FilePointer
export function isFilePointer(value: unknown): value is FilePointer {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.storage_path === 'string' &&
    typeof obj.original_filename === 'string'
  );
}

// Format file size for display
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Render a single FilePointer as a clickable file chip
export function FilePointerDisplay({ file }: { file: FilePointer }) {
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  useEffect(() => {
    // Get signed URL for download
    async function getUrl() {
      try {
        const { data } = await supabase.storage
          .from('attachments')
          .createSignedUrl(file.storage_path, 3600); // 1 hour
        if (data?.signedUrl) {
          setDownloadUrl(data.signedUrl);
        }
      } catch {
        // Silently fail - user can still see filename
      }
    }
    getUrl();
  }, [file.storage_path]);

  return (
    <a
      href={downloadUrl || '#'}
      download={file.original_filename}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-1 rounded-md",
        "bg-muted hover:bg-muted/80 transition-colors",
        "text-sm text-foreground",
        !downloadUrl && "pointer-events-none opacity-60"
      )}
    >
      <FileIcon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="truncate max-w-[200px]">{file.original_filename}</span>
      <span className="text-[10px] text-muted-foreground">({formatFileSize(file.size_bytes)})</span>
      {downloadUrl && <Download className="h-3 w-3 text-muted-foreground" />}
    </a>
  );
}

// Schema chip component with portaled tooltip (hover to see output schema)
function SchemaChip({
  outputSchema,
  size = 'sm',
  tooltipPosition = 'bottom'
}: {
  outputSchema: { fields: ResponseSchemaField[] } | undefined;
  size?: 'sm' | 'md';
  tooltipPosition?: 'top' | 'bottom';
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLDivElement>(null);

  const iconSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  const padding = size === 'sm' ? 'p-1' : 'p-1.5';
  const tooltipWidth = 256;

  const hasSchema = outputSchema?.fields && outputSchema.fields.length > 0;

  const handleMouseEnter = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const style: React.CSSProperties = {
        position: 'fixed',
        width: tooltipWidth,
        zIndex: 9999,
      };

      if (tooltipPosition === 'top') {
        style.top = rect.bottom + 8;
        style.left = rect.left;
      } else {
        style.bottom = window.innerHeight - rect.top + 8;
        style.right = window.innerWidth - rect.right;
      }

      setTooltipStyle(style);
    }
    setIsHovered(true);
  }, [tooltipPosition]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
  }, []);

  return (
    <>
      <div
        ref={triggerRef}
        className="relative flex-shrink-0"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className={cn(padding, "rounded hover:bg-muted transition-colors cursor-default")}
        >
          <FileJson className={cn(iconSize, hasSchema ? "text-muted-foreground" : "text-muted-foreground/50")} />
        </div>
      </div>
      {isHovered && createPortal(
        <div style={tooltipStyle} className="pointer-events-none">
          <div className="rounded-lg border border-border p-3 shadow-lg bg-background/80" style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Output Schema</div>
            {hasSchema ? (
              <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
                {outputSchema.fields.map((field, idx) => (
                  <div key={idx} className="text-xs">
                    <div className="flex items-center gap-1.5">
                      <code className="font-mono bg-muted px-1 py-0.5 rounded text-[10px]">{field.name}</code>
                      <span className="text-muted-foreground text-[10px]">{formatFieldType(field.type)}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 pl-0.5">{field.description}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">No schema defined</p>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// Structured response display (shown when task completes with extracted data)
function StructuredResponseDisplay({
  structuredResponse,
  outputSchema
}: {
  structuredResponse: Record<string, unknown> | undefined;
  outputSchema: { fields: ResponseSchemaField[] } | undefined;
}) {
  if (!structuredResponse || Object.keys(structuredResponse).length === 0) {
    return null;
  }

  // Render a value based on its type
  const renderValue = (value: unknown, fieldType?: ResponseSchemaField['type']) => {
    // Handle FilePointer type
    if (fieldType === 'file_pointer' && isFilePointer(value)) {
      return <FilePointerDisplay file={value} />;
    }

    // Handle list[file_pointer] type
    if (fieldType === 'list[file_pointer]' && Array.isArray(value)) {
      const filePointers = value.filter(isFilePointer);
      if (filePointers.length > 0) {
        return (
          <div className="flex flex-wrap gap-1.5">
            {filePointers.map((fp) => (
              <FilePointerDisplay key={fp.id} file={fp} />
            ))}
          </div>
        );
      }
    }

    // Auto-detect FilePointer even if field type isn't specified
    if (isFilePointer(value)) {
      return <FilePointerDisplay file={value} />;
    }

    // Format other values
    let formattedValue: string;
    if (Array.isArray(value)) {
      formattedValue = value.join(', ');
    } else if (typeof value === 'object' && value !== null) {
      formattedValue = JSON.stringify(value, null, 2);
    } else if (value === null || value === undefined) {
      formattedValue = '—';
    } else {
      formattedValue = String(value);
    }

    return <p className="text-muted-foreground break-words whitespace-pre-wrap">{formattedValue}</p>;
  };

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Extracted Output</div>
      <div className="space-y-2">
        {Object.entries(structuredResponse).map(([key, value]) => {
          // Find the field definition if available
          const fieldDef = outputSchema?.fields?.find(f => f.name === key);
          const formattedKey = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

          return (
            <div key={key} className="text-sm">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="font-medium text-foreground">{formattedKey}</span>
                {fieldDef && (
                  <span className="text-[10px] text-muted-foreground">({formatFieldType(fieldDef.type)})</span>
                )}
              </div>
              {renderValue(value, fieldDef?.type)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ClaudeCodeChipProps {
  taskId: string;
  wsUrl?: string;
  forceShow?: boolean; // Always show terminal regardless of state
}

type WsMessage =
  | { type: 'buffer'; data: string }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'stdin_echo'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; data: string };

type ChipState = 'spinning_up' | 'live' | 'verifying' | 'completed' | 'failed';

const RETRY_DELAYS = [100, 400, 800]; // ms between retries (backend guarantees WS is ready)
const MAX_RETRIES = 3;

export default function ClaudeCodeChip({ taskId, wsUrl, forceShow = false }: ClaudeCodeChipProps) {
  const { messages } = useAgentContext();

  // Terminal refs
  const terminalRef = useRef<HTMLDivElement>(null);
  const fullscreenTerminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<XTermTerminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const outputBuffer = useRef<string>('');

  // State
  const [chipState, setChipState] = useState<ChipState>('spinning_up');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fetchedOutput, setFetchedOutput] = useState(false);

  // Ref to track completion state for WS close handler (avoids stale closure)
  const isCompletedRef = useRef(false);

  // Extract data from context messages
  const { isComplete, isSuccess, isVerifying, outputSchema, structuredResponse, failureMessage, githubRepoUrl } = useMemo(() => {
    const claudeCodeMessages = messages.filter(m => m.metadata?.task_id === taskId);
    const lastMessage = claudeCodeMessages[claudeCodeMessages.length - 1];

    const complete = lastMessage?.metadata?.action_type === 'task_complete';
    const success = complete && lastMessage?.metadata?.title?.includes('Completed');

    // Check if verifier is running
    const verifying = !complete && lastMessage?.metadata?.action_type === 'system' &&
      lastMessage?.metadata?.title?.includes('Verifying') &&
      lastMessage?.metadata?.toolStatus === 'IN_PROGRESS';

    // Extract output schema from init message
    const initMessage = claudeCodeMessages.find(m => m.metadata?.output_schema);
    const schema = initMessage?.metadata?.output_schema as { fields: ResponseSchemaField[] } | undefined;

    // Extract structured response from completion message
    const completionMsg = claudeCodeMessages.find(m => m.metadata?.action_type === 'task_complete');
    const extracted = completionMsg?.metadata?.structured_response as Record<string, unknown> | undefined;

    // Extract failure message - check ERROR status first, then Task Incomplete
    let failureText: string | null = null;
    const errorMsg = claudeCodeMessages.find(m => m.metadata?.toolStatus === 'ERROR');
    if (errorMsg?.text) {
      failureText = errorMsg.text;
    } else if (complete && !success && completionMsg?.text) {
      failureText = completionMsg.text;
    }

    // Extract GitHub repo URL from init message
    const githubUrl = initMessage?.metadata?.github_repo_url as string | undefined;

    return {
      isComplete: complete,
      isSuccess: success,
      isVerifying: verifying,
      outputSchema: schema,
      structuredResponse: extracted,
      failureMessage: failureText,
      githubRepoUrl: githubUrl,
    };
  }, [messages, taskId]);

  // Update chip state based on completion/verifying
  useEffect(() => {
    if (isComplete) {
      isCompletedRef.current = true;
      setChipState(isSuccess ? 'completed' : 'failed');
    } else if (isVerifying) {
      setChipState('verifying');
    }
  }, [isComplete, isSuccess, isVerifying]);

  // Fetch saved output from backend when expanding completed terminal
  const fetchSavedOutput = useCallback(async () => {
    if (fetchedOutput) return;
    if (outputBuffer.current) return;
    if (taskId === 'pending') return;

    try {
      const url = `${API_URL}/api/claude-code-session/${taskId}`;

      // Get auth token
      const session = getSession();
      const token = session?.access_token;
      if (!token) return;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();

        if (data.output) {
          // Store in buffer - terminal will write it when initialized
          outputBuffer.current = data.output;
          // Write to terminal - it should exist by now since we're expanded
          if (terminalInstance.current) {
            terminalInstance.current.write(data.output);
          }
          setFetchedOutput(true);
        }
      }
    } catch {
      // Silently fail - output fetch is best-effort
    }
  }, [taskId, fetchedOutput]);

  // Fetch output when terminal is expanded in completed state
  useEffect(() => {
    if ((isExpanded || isFullscreen) && (chipState === 'completed' || chipState === 'failed')) {
      fetchSavedOutput();
    }
  }, [isExpanded, isFullscreen, chipState, fetchSavedOutput]);

  // Initialize terminal
  const initTerminal = useCallback((container: HTMLDivElement) => {
    if (terminalInstance.current) {
      terminalInstance.current.dispose();
    }

    const terminal = new XTermTerminal({
      theme: {
        background: '#1a1a1a',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        cursorAccent: '#1a1a1a',
        selectionBackground: '#444444',
        black: '#000000',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#bd93f9',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#f8f8f2',
        brightBlack: '#6272a4',
        brightRed: '#ff6e6e',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#d6acff',
        brightMagenta: '#ff92df',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff',
      },
      fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: false,
      scrollback: 10000,
      convertEol: true,
      disableStdin: true, // View-only
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);

    // Delay fit to ensure container has dimensions
    requestAnimationFrame(() => {
      fit.fit();
    });

    terminalInstance.current = terminal;
    fitAddon.current = fit;

    // Write any buffered output
    if (outputBuffer.current) {
      terminal.write(outputBuffer.current);
    }

    return terminal;
  }, []);

  // Connect to WebSocket with retry logic
  const connectWebSocket = useCallback((attempt: number = 0) => {
    if (!wsUrl || isCompletedRef.current) return;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setChipState('live');
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data);

        switch (msg.type) {
          case 'buffer':
            // Full history buffer from server
            outputBuffer.current = msg.data;
            terminalInstance.current?.write(msg.data);
            break;
          case 'stdout':
          case 'stderr':
            // Live output - append to buffer and write
            outputBuffer.current += msg.data;
            terminalInstance.current?.write(msg.data);
            break;
          case 'stdin_echo':
            // Echo of input sent by parent agent - display in terminal
            outputBuffer.current += msg.data;
            terminalInstance.current?.write(msg.data);
            break;
          case 'exit':
            isCompletedRef.current = true;
            setChipState(msg.code === 0 ? 'completed' : 'failed');
            break;
          case 'error':
            terminalInstance.current?.write(`\r\n\x1b[31mError: ${msg.data}\x1b[0m\r\n`);
            break;
        }
      } catch {
        // Not JSON, treat as raw data
        outputBuffer.current += event.data;
        terminalInstance.current?.write(event.data);
      }
    };

    ws.onerror = () => {
      // Error handling done in onclose
    };

    ws.onclose = () => {
      // Retry with fixed delays (only if not complete)
      // Don't set failed state here - let DB messages drive state via realtime
      // WS close is expected when task completes (backend closes connection)
      // Use ref to avoid stale closure — isComplete from DB may lag behind WS exit
      if (attempt < MAX_RETRIES - 1 && !isCompletedRef.current) {
        const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        setTimeout(() => connectWebSocket(attempt + 1), delay);
      }
      // State will be updated via useEffect when isComplete changes from DB
    };
  }, [wsUrl]);

  // Connect WS on mount
  useEffect(() => {
    if (wsUrl && !isCompletedRef.current) {
      connectWebSocket(0);
    }

    return () => {
      wsRef.current?.close();
    };
  }, [wsUrl, connectWebSocket]);

  // Close WebSocket when task completes or component state indicates completion
  useEffect(() => {
    if (isComplete || chipState === 'completed' || chipState === 'failed') {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
    }
  }, [isComplete, chipState]);

  // Handle terminal container ref changes
  // Initialize terminal when: forceShow, live state (inline), expanded, or fullscreen
  useEffect(() => {
    const container = isFullscreen ? fullscreenTerminalRef.current : terminalRef.current;
    const shouldShowTerminal = forceShow || chipState === 'live' || isExpanded || isFullscreen;

    if (container && shouldShowTerminal) {
      initTerminal(container);

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        fitAddon.current?.fit();
      });
      resizeObserver.observe(container);

      return () => {
        resizeObserver.disconnect();
      };
    }
  }, [forceShow, chipState, isExpanded, isFullscreen, initTerminal]);

  // Status indicator mapping
  const STATUS_CONFIG: Record<ChipState, { indicator: React.ReactNode; text: string }> = {
    spinning_up: {
      indicator: <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />,
      text: 'Spinning up...',
    },
    live: {
      indicator: <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />,
      text: 'Claude Code Active',
    },
    verifying: {
      indicator: <Loader2 className="h-4 w-4 animate-spin text-blue-500" />,
      text: 'Verifying Result...',
    },
    completed: {
      indicator: <CheckCircle2 className="h-4 w-4 text-green-500" />,
      text: 'Claude Code Completed Successfully',
    },
    failed: {
      indicator: <XCircle className="h-4 w-4 text-red-500" />,
      text: 'Claude Code Failed',
    },
  };

  const { indicator: statusIndicator, text: statusText } = STATUS_CONFIG[chipState];

  const githubLink = githubRepoUrl ? (
    <a
      href={githubRepoUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <ExternalLink className="h-3 w-3" />
      <span>Repo</span>
    </a>
  ) : null;

  // Fullscreen portal
  if (isFullscreen) {
    return createPortal(
      <div className="fixed inset-0 z-50 bg-background flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-3">
            <img src={ClaudeIcon} alt="Claude Code" className="h-5 w-5" />
            {statusIndicator}
            <span className="text-sm font-medium">{statusText}</span>
            <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="top" />
            {githubLink}
          </div>
          <button
            onClick={() => setIsFullscreen(false)}
            className="p-2 rounded hover:bg-muted transition-colors"
          >
            <X className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>

        {/* Terminal */}
        <div className="flex-1 bg-[#1a1a1a] relative">
          <div
            ref={fullscreenTerminalRef}
            className="w-full h-full px-2"
          />
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border bg-muted/20">
          <p className="text-xs text-muted-foreground italic">
            Claude Code is working autonomously in a sandboxed environment
          </p>
        </div>
      </div>,
      document.body
    );
  }

  // Collapsed chip (completed/failed state)
  if (chipState === 'completed' || chipState === 'failed') {
    return (
      <div className="w-full">
        <div
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-colors cursor-pointer"
        >
          {/* Claude icon - no black background */}
          <img src={ClaudeIcon} alt="Claude Code" className="h-5 w-5" />

          {/* Status */}
          <div className="flex-1 flex items-center gap-2 min-w-0">
            {statusIndicator}
            <span className="text-sm font-medium truncate">{statusText}</span>
          </div>

          {/* Schema chip + GitHub link + Expand/Collapse */}
          <div className="flex items-center gap-1">
            {githubLink}
            <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="bottom" />
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsFullscreen(true);
              }}
              className="p-1.5 rounded hover:bg-muted transition-colors"
            >
              <Maximize2 className="h-4 w-4 text-muted-foreground" />
            </button>
            {isExpanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        </div>

        {/* Structured response (extracted output) - only show when expanded and completed successfully */}
        {isExpanded && chipState === 'completed' && structuredResponse && Object.keys(structuredResponse).length > 0 && (
          <StructuredResponseDisplay structuredResponse={structuredResponse} outputSchema={outputSchema} />
        )}

        {/* Failure message - show when expanded and failed */}
        {isExpanded && chipState === 'failed' && failureMessage && (
          <div className="mt-2 p-3 rounded-lg border border-red-500/30 bg-red-500/10">
            <p className="text-sm text-red-400 whitespace-pre-wrap">{failureMessage}</p>
          </div>
        )}

        {/* Expanded terminal */}
        {isExpanded && (
          <div className="mt-2 rounded-xl border border-border overflow-hidden">
            <div className="bg-[#1a1a1a] h-[360px]">
              <div ref={terminalRef} className="w-full h-full px-2" />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Spinning up state
  if (chipState === 'spinning_up') {
    // If forceShow, display terminal even while spinning up
    if (forceShow) {
      return (
        <div className="w-full">
          <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm overflow-hidden">
            {/* Header - compact with spinner */}
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-border">
              <div className="flex items-center gap-2">
                <img src={ClaudeIcon} alt="Claude Code" className="h-4 w-4" />
                <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />
                <span className="text-xs font-medium">Claude Code Spinning up...</span>
                <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="bottom" />
                {githubLink}
              </div>
              <button
                onClick={() => setIsFullscreen(true)}
                className="p-1 rounded hover:bg-muted transition-colors"
              >
                <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>

            {/* Terminal */}
            <div className="bg-[#1a1a1a] h-[468px]">
              <div ref={terminalRef} className="w-full h-full px-2" />
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card/50 backdrop-blur-sm">
        <img src={ClaudeIcon} alt="Claude Code" className="h-5 w-5" />
        <div className="flex-1 flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />
          <span className="text-sm text-muted-foreground">Claude Code Spinning up...</span>
        </div>
        <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="bottom" />
        {githubLink}
      </div>
    );
  }

  // Live or verifying state - show inline terminal
  return (
    <div className="w-full">
      <div className="rounded-xl border border-border bg-card/50 backdrop-blur-sm overflow-hidden">
        {/* Header - compact */}
        <div className="flex items-center justify-between px-2 py-1.5 border-b border-border">
          <div className="flex items-center gap-2">
            <img src={ClaudeIcon} alt="Claude Code" className="h-4 w-4" />
            {statusIndicator}
            <span className="text-xs font-medium">{statusText}</span>
            <SchemaChip outputSchema={outputSchema} size="sm" tooltipPosition="bottom" />
            {githubLink}
          </div>
          <button
            onClick={() => setIsFullscreen(true)}
            className="p-1 rounded hover:bg-muted transition-colors"
          >
            <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>

        {/* Terminal */}
        <div className="bg-[#1a1a1a] h-[468px]">
          <div ref={terminalRef} className="w-full h-full px-2" />
        </div>
      </div>
    </div>
  );
}
