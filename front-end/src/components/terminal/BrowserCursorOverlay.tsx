/**
 * BrowserCursorOverlay - Renders cursor on top of browser view
 *
 * STATE MACHINE:
 * [VISIBLE] --> cursor always visible at current position
 *    |
 *    v (new message with coordinates)
 * [MOVING] --> CSS transition animates to new position
 *    |
 *    v (transition complete)
 * [VISIBLE]
 *
 * Coordinates come from browser action messages (IN_PROGRESS) via metadata.auxiliary.coordinates
 * Browser viewport is 1280x800, uses percentage positioning for immediate rendering
 */

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { Message } from '@/lib/api';

// Steel browser dimensions
// Debug view shows full browser window (1288x891), content viewport is 1280x800
// Chrome offsets: ~4px left border, ~91px top toolbar
const BROWSER_WINDOW_WIDTH = 1288;
const BROWSER_WINDOW_HEIGHT = 891;
const CONTENT_VIEWPORT_WIDTH = 1280;
const CONTENT_VIEWPORT_HEIGHT = 800;
const CHROME_OFFSET_X = 4; // Left border
const CHROME_OFFSET_Y = 91; // Toolbar height
const WINDOW_ASPECT = BROWSER_WINDOW_WIDTH / BROWSER_WINDOW_HEIGHT;

// Custom cursor SVG - navigation arrow pointing right (from navigate-v2.png, flipped)
// Auto-traced using potrace from the actual PNG. Black fill, 4px white stroke.
// Tip is on right edge after flip; translateX(-28px) aligns tip with click point.
const CURSOR_SVG = `<svg width="28" height="28" viewBox="0 0 427 427" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(427, 0) scale(-1, 1)">
    <g transform="translate(-43, 470) scale(0.1, -0.1)">
      <path d="M669 4687 c-149 -42 -244 -165 -242 -312 1 -77 1202 -3705 1257 -3800 116 -198 438 -191 548 11 15 27 128 389 253 804 322 1072 177 927 1255 1250 830 249 777 231 840 281 165 131 146 408 -36 515 -59 35 -3711 1251 -3777 1258 -29 3 -72 0 -98 -7z"
            fill="#1a1a1a" stroke="#ffffff" stroke-width="40" stroke-linejoin="round"/>
    </g>
  </g>
</svg>`;

interface BrowserCursorOverlayProps {
  taskId: string;
  messages: Message[];
}

interface CursorPosition {
  x: number;
  y: number;
}

export default function BrowserCursorOverlay({ taskId, messages }: BrowserCursorOverlayProps) {
  const [cursorPos, setCursorPos] = useState<CursorPosition>({ x: 640, y: 400 }); // Center
  const lastProcessedMessageRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportBounds, setViewportBounds] = useState({
    offsetX: 0,
    offsetY: 0,
    width: 0,
    height: 0,
  });

  // Calculate viewport bounds within container (fit-contain logic)
  // Step 1: Calculate where the browser WINDOW fits (1288x891)
  // Step 2: Within that, calculate where the content viewport is (1280x800 offset by chrome)
  const updateViewportBounds = useCallback(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    const containerAspect = containerWidth / containerHeight;

    // First, calculate browser window bounds (fit-contain for 1288x891)
    let windowWidth: number, windowHeight: number, windowOffsetX: number, windowOffsetY: number;

    if (containerAspect > WINDOW_ASPECT) {
      // Container is wider - window fills height, pillarboxed horizontally
      windowHeight = containerHeight;
      windowWidth = containerHeight * WINDOW_ASPECT;
      windowOffsetX = (containerWidth - windowWidth) / 2;
      windowOffsetY = 0;
    } else {
      // Container is taller - window fills width, letterboxed vertically
      windowWidth = containerWidth;
      windowHeight = containerWidth / WINDOW_ASPECT;
      windowOffsetX = 0;
      windowOffsetY = (containerHeight - windowHeight) / 2;
    }

    // Scale factor from original window to rendered window
    const scale = windowWidth / BROWSER_WINDOW_WIDTH;

    // Content viewport position within the rendered window
    const vpOffsetX = windowOffsetX + CHROME_OFFSET_X * scale;
    const vpOffsetY = windowOffsetY + CHROME_OFFSET_Y * scale;
    const vpWidth = CONTENT_VIEWPORT_WIDTH * scale;
    const vpHeight = CONTENT_VIEWPORT_HEIGHT * scale;

    setViewportBounds({ offsetX: vpOffsetX, offsetY: vpOffsetY, width: vpWidth, height: vpHeight });
  }, []);

  // Update bounds on mount and resize
  useEffect(() => {
    updateViewportBounds();
    const observer = new ResizeObserver(updateViewportBounds);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, [updateViewportBounds]);

  // Filter for this browser's messages with coordinates
  const latestWithCoords = useMemo(() => {
    const browserMessages = messages.filter(
      (m) => m.metadata?.task_id === taskId && m.metadata?.auxiliary?.coordinates,
    );
    return browserMessages[browserMessages.length - 1];
  }, [messages, taskId]);

  // Update cursor position when new coordinates arrive
  useEffect(() => {
    if (!latestWithCoords) return;

    const messageId = latestWithCoords.message_id;
    if (messageId === lastProcessedMessageRef.current) return;
    lastProcessedMessageRef.current = messageId;

    const coords = latestWithCoords.metadata?.auxiliary?.coordinates as CursorPosition | undefined;
    if (coords?.x !== undefined && coords?.y !== undefined) {
      setCursorPos({ x: coords.x, y: coords.y });
    }
  }, [latestWithCoords]);

  // Convert browser coords (in content viewport space 1280x800) to pixel position
  const cursorLeft =
    viewportBounds.offsetX + (cursorPos.x / CONTENT_VIEWPORT_WIDTH) * viewportBounds.width;
  const cursorTop =
    viewportBounds.offsetY + (cursorPos.y / CONTENT_VIEWPORT_HEIGHT) * viewportBounds.height;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'visible',
        zIndex: 10, // Above BrowserBorderGlow
      }}
    >
      {/* Cursor - always visible, positioned relative to viewport bounds */}
      {/* translateX(-28px) aligns tip (on right edge of flipped SVG) with click point */}
      <div
        style={{
          position: 'absolute',
          left: cursorLeft,
          top: cursorTop,
          width: 28,
          height: 28,
          pointerEvents: 'none',
          filter: 'drop-shadow(2px 3px 3px rgba(0, 0, 0, 0.5))',
          transition: 'left 0.3s ease-out, top 0.3s ease-out',
          transform: 'translateX(-28px)',
          willChange: 'left, top',
        }}
        dangerouslySetInnerHTML={{ __html: CURSOR_SVG }}
      />
    </div>
  );
}
