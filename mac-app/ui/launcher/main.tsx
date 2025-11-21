import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import type { QuickQueryToggleState } from '../../shared/types/ipc';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from '@/components/ui/command';
import { AppDataProvider, useAppData } from '@/hooks/useAppData';
import { ChevronDown } from 'lucide-react';

// Add drag styles
const style = document.createElement('style');
style.textContent = `
  body, #root {
    margin: 0;
    padding: 0;
    background: transparent !important;
  }
  body > div:first-child {
    -webkit-app-region: drag;
  }
  button, input, textarea, select {
    -webkit-app-region: no-drag;
  }
`;
document.head.appendChild(style);

const Launcher = () => {
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [selectedModel, setSelectedModel] = useState('rose-labs/rose-1-fast');
  const [showModelPicker, setShowModelPicker] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { models } = useAppData();

  // Auto-resize textarea based on content
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [query]);

  useEffect(() => {
    const toggleHandler = (state: QuickQueryToggleState) => {
      if (state.open) {
        setQuery('');
        setSubmitting(false);
        setTimeout(() => textareaRef.current?.focus(), 100);
      }
    };

    window.api.onQuickQueryToggle(toggleHandler);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        window.api.hideQuickQuery();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim() || submitting) return;

    setSubmitting(true);
    try {
      await window.api.submitQuickQuery({
        query: query.trim(),
        submittedAt: Date.now(),
      });
      // Query is sent to main window, close the launcher
      // The main window will receive it and handle it
    } catch (err) {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="relative h-full w-full rounded-xl border p-2 shadow-lg overflow-hidden"
      style={{
        backdropFilter: 'blur(24px) saturate(1.09) brightness(1.09)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.09) brightness(1.09)',
        backgroundColor: 'rgba(255, 255, 255, 0.98)',
        borderColor: 'rgba(218, 218, 218, 0.615)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.04), 0 0 2.56px rgba(126, 87, 194, 0.0128), inset 0 1px 1px rgba(255,255,255,0.315)',
      }}
    >
      {/* Marble gradient background - soft white with pastel hints */}
      <div 
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(circle at 15% 30%, rgba(255, 248, 245, 0.021) 0%, transparent 45%), 
                       radial-gradient(circle at 85% 70%, rgba(248, 245, 255, 0.018) 0%, transparent 45%),
                       radial-gradient(circle at 50% 50%, rgba(255, 250, 255, 0.015) 0%, transparent 55%),
                       radial-gradient(circle at 30% 80%, rgba(252, 248, 255, 0.0165) 0%, transparent 50%)`,
          opacity: 0.265,
          zIndex: -1,
        }}
      />
      <form
        onSubmit={handleSubmit}
        className="relative z-10 flex h-full flex-col justify-between"
      >
          <div className="flex flex-col justify-between h-full">
                {/* Textarea */}
                <div className="relative px-2">
                  <textarea
                    ref={textareaRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={submitting}
                    placeholder="Enter your goal"
                    className={cn(
                      'w-full resize-none border-none bg-transparent py-1 text-base leading-6 text-gray-900 placeholder:text-gray-400 focus:outline-none dark:text-gray-100 dark:placeholder:text-gray-500'
                    )}
                    rows={1}
                    style={{ 
                      WebkitAppRegion: 'no-drag',
                      minHeight: '28px',
                      maxHeight: '120px',
                      overflow: 'hidden'
                    } as React.CSSProperties}
                  />
                </div>

                {/* Bottom bar */}
                <div className="flex items-center justify-between gap-2 px-2 pt-0.5">
                  <Popover open={showModelPicker} onOpenChange={setShowModelPicker}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-gray-100 px-2 py-1 text-xs text-gray-700 shadow-sm hover:bg-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                      >
                        <span>{selectedModel}</span>
                        <ChevronDown className="h-3 w-3" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[300px] p-0 z-[10000]" align="start">
                      <Command className="bg-white dark:bg-gray-900">
                        <CommandInput placeholder="Search models..." />
                        <CommandList className="max-h-[400px]">
                          <CommandEmpty>No models available.</CommandEmpty>
                          <CommandGroup heading="⭐ Featured">
                            {models.slice(0, 6).map((model) => (
                              <CommandItem
                                key={model.id}
                                onSelect={() => {
                                  setSelectedModel(model.id);
                                  setShowModelPicker(false);
                                }}
                              >
                                <div className="flex items-center justify-between w-full">
                                  <div className="flex flex-col gap-0.5">
                                    <span className="font-medium">{model.name}</span>
                                    <span className="text-xs text-gray-500">{model.provider}</span>
                                  </div>
                                  {model.id === selectedModel && (
                                    <span className="text-primary">✓</span>
                                  )}
                                </div>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                          {models.length > 6 && (
                            <CommandGroup heading="All Models">
                              {models.slice(6).map((model) => (
                                <CommandItem
                                  key={model.id}
                                  onSelect={() => {
                                    setSelectedModel(model.id);
                                    setShowModelPicker(false);
                                  }}
                                >
                                  <div className="flex items-center justify-between w-full">
                                    <div className="flex flex-col gap-0.5">
                                      <span className="text-sm">{model.name}</span>
                                      <span className="text-xs text-gray-500">{model.provider}</span>
                                    </div>
                                    {model.id === selectedModel && (
                                      <span className="text-primary">✓</span>
                                    )}
                                  </div>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          )}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="flex items-center gap-1 rounded-lg border border-gray-300 bg-gray-100 px-2 py-1 text-xs text-gray-700 shadow-sm hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    <span className="font-mono text-[17px] leading-none">⌘</span>
                    <span className="font-mono text-xs">+</span>
                    <span className="font-mono text-xs">Enter</span>
                  </button>
                </div>
          </div>
      </form>
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppDataProvider>
      <Launcher />
    </AppDataProvider>
  </React.StrictMode>
);


