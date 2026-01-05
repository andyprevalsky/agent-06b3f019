import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import type { QuickQueryToggleState } from '../../shared/types/ipc';
import { AppDataProvider } from '@/hooks/useAppData';
import LiquidWhiteButton from '@/components/ui/liquid-white-button';
import { ArrowUp } from 'lucide-react';
import { liquidMetalFragmentShader, ShaderMount } from '@paper-design/shaders';

// Liquid metal shader component - fills parent container
const ShaderTile = ({ size }: { size: number }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const shaderRef = useRef<ShaderMount | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (shaderRef.current) {
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
      if (shaderRef.current) {
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
        maskImage: 'linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0) 100%)',
        WebkitMaskImage: 'linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0) 100%)',
        pointerEvents: 'none',
      }}
    />
  );
};

// Styles - must override Tailwind's bg-background
const style = document.createElement('style');
style.textContent = `
  html, body, #root {
    margin: 0 !important;
    padding: 0 !important;
    background: transparent !important;
    background-color: transparent !important;
    width: 100% !important;
    height: 100% !important;
  }
  body {
    background: transparent !important;
    background-color: transparent !important;
  }
  .drag-region {
    -webkit-app-region: drag;
  }
  button, input, textarea, select {
    -webkit-app-region: no-drag;
  }
  .placeholder-input::placeholder {
    color: rgba(39, 39, 37, 0.5);
  }
`;
document.head.appendChild(style);

const Launcher = () => {
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const toggleHandler = (state: QuickQueryToggleState) => {
      if (state.open) {
        setQuery('');
        setSubmitting(false);
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    };

    window.api.onQuickQueryToggle(toggleHandler);

    // Listen for focus-input events from main process
    window.api.onFocusInput(() => {
      inputRef.current?.focus();
    });

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
    } catch (err) {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="drag-region" style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        className="drag-region"
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          right: 8,
          bottom: 8,
          borderRadius: 9999,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15), 0 2px 4px rgba(0, 0, 0, 0.1)',
        }}
      >
        {/* Shader background */}
        <div style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 9999,
          overflow: 'hidden'
        }}>
          <ShaderTile size={52} />
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
          }}
        >
          <form
            onSubmit={handleSubmit}
            style={{
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              height: '100%',
              gap: 12,
              paddingLeft: 16,
              paddingRight: 4,
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={submitting}
              placeholder="What do you want to do?"
              className="placeholder-input"
              style={{
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                fontSize: 13,
                color: '#272725',
                border: 'none',
                outline: 'none',
              } as React.CSSProperties}
            />

            <LiquidWhiteButton
              onClick={() => handleSubmit()}
              disabled={submitting}
              size="sm"
            >
              <ArrowUp className="w-5 h-5" strokeWidth={2.5} />
            </LiquidWhiteButton>
          </form>
        </div>
      </div>
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
