/**
 * STATE MACHINE: Browse
 *
 * URL ENTRY:
 * [READY] -- submit url/search --> [NAVIGATING] -- did-navigate/load-stop --> [READY]
 *    |                                  |
 *    | webview did-fail-load            | external webview failure
 *    v                                  v
 * [ERROR] <------------------------ [ERROR]
 *
 * HISTORY CONTROLS:
 * [CAN_GO_BACK/FORWARD] are derived from webview history events.
 */

import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { DEFAULT_BROWSE_URL } from '../config';

type WebviewElement = HTMLElement & {
  src: string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
};

interface WebviewNavigationEvent extends Event {
  url?: string;
}

function normalizeUrl(input: string): string {
  const value = input.trim();
  if (value === '') return DEFAULT_BROWSE_URL;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

export default function Browse() {
  const webviewRef = useRef<WebviewElement | null>(null);
  const [currentUrl, setCurrentUrl] = useState(DEFAULT_BROWSE_URL);
  const [draftUrl, setDraftUrl] = useState(DEFAULT_BROWSE_URL);
  const [isLoading, setIsLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const refreshHistoryState = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    setCanGoBack(webview.canGoBack());
    setCanGoForward(webview.canGoForward());
  }, []);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return undefined;

    const handleStart = () => {
      setIsLoading(true);
      setLoadFailed(false);
    };
    const handleStop = () => {
      setIsLoading(false);
      refreshHistoryState();
    };
    const handleNavigate = (event: Event) => {
      const url = (event as WebviewNavigationEvent).url;
      if (url) {
        setCurrentUrl(url);
        setDraftUrl(url);
      }
      refreshHistoryState();
    };
    const handleFail = () => {
      setIsLoading(false);
      setLoadFailed(true);
      refreshHistoryState();
    };

    webview.addEventListener('did-start-loading', handleStart);
    webview.addEventListener('did-stop-loading', handleStop);
    webview.addEventListener('did-navigate', handleNavigate);
    webview.addEventListener('did-navigate-in-page', handleNavigate);
    webview.addEventListener('did-fail-load', handleFail);

    return () => {
      webview.removeEventListener('did-start-loading', handleStart);
      webview.removeEventListener('did-stop-loading', handleStop);
      webview.removeEventListener('did-navigate', handleNavigate);
      webview.removeEventListener('did-navigate-in-page', handleNavigate);
      webview.removeEventListener('did-fail-load', handleFail);
    };
  }, [refreshHistoryState]);

  const navigateToDraft = useCallback(() => {
    const nextUrl = normalizeUrl(draftUrl);
    setCurrentUrl(nextUrl);
    setDraftUrl(nextUrl);
    setIsLoading(true);
    setLoadFailed(false);
  }, [draftUrl]);

  const webviewProps = {
    ref: webviewRef,
    src: currentUrl,
    className: 'h-full w-full bg-white',
    allowpopups: 'true',
    webpreferences: 'contextIsolation=yes, nodeIntegration=no, javascript=yes',
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/50 bg-background/90 px-3 py-2 shadow-sm">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Back"
          disabled={!canGoBack}
          onClick={() => webviewRef.current?.goBack()}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Forward"
          disabled={!canGoForward}
          onClick={() => webviewRef.current?.goForward()}
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Reload"
          onClick={() => webviewRef.current?.reload()}
        >
          <RotateCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
        </Button>
        <form
          className="relative flex min-w-0 flex-1 items-center"
          onSubmit={(event) => {
            event.preventDefault();
            navigateToDraft();
          }}
        >
          <Globe className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground" />
          <Input
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            className="h-9 rounded-md border-border/70 bg-background pl-9 text-sm"
            aria-label="URL or search"
            spellCheck={false}
          />
        </form>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden border-b border-border/50 bg-white">
        {createElement('webview', webviewProps)}
        {loadFailed && (
          <div className="pointer-events-none absolute inset-x-0 top-0 border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            Failed to load {currentUrl}
          </div>
        )}
      </div>
    </div>
  );
}
