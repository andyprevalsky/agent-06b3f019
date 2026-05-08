/**
 * STATE MACHINE: ThinkingAnimation
 *
 * ThinkingAnimation - plays back recorded SVG animations.
 * Supports two data formats:
 * 1. XML Frame format: { meta?: {...}, frames: [{ t, xml }] } - full SVG per frame
 * 2. Delta format: { attrs, base, frames: [{ t, changed }] } - requires separate SVG file
 *
 * DATA LOADING:
 * [LOADING] <-- data loading from URL
 *     |
 *     v (data loaded)
 * [READY]
 *
 * PLAYBACK STATE (via useXmlFrameReplay hook):
 * [STOPPED] <-- autoplay: false, not playing
 *     |
 *     | (play())
 *     v
 * [PLAYING] <-- requestAnimationFrame loop running
 *     |
 *     +--> currentFrameIndex advances through frames
 *     |
 *     | (pause() or end)
 *     v
 * [STOPPED] or [LOOPING] (if loop: true)
 *
 * GRADIENT THEMING:
 * When `gradient` prop is provided, all rgb() colors in SVG frames are remapped
 * to the given palette based on luminance. Used for Claude orange theming.
 *
 * State:
 * - svgRef: current frame SVG content
 * - isPlaying, play(), pause() from hook
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type CSSProperties,
} from 'react';
import { useXmlFrameReplay, type XmlFrameData } from '@/hooks/useXmlFrameReplay';
import { DEFAULT_THINKING_ANIMATION_URL, resolveAnimationUrl } from './thinkingAnimationUrl';

export interface ThinkingAnimationProps {
  dataUrl?: string;
  data?: XmlFrameData;
  autoplay?: boolean;
  loop?: boolean;
  playbackSpeed?: number;
  className?: string;
  style?: CSSProperties;
  onDone?: () => void;
  /** Optional color palette (hex strings) to remap SVG colors via luminance mapping */
  gradient?: string[];
}

export interface ThinkingAnimationHandle {
  play: () => void;
  pause: () => void;
  restart: () => void;
  seek: (frameIndex: number) => void;
  isPlaying: () => boolean;
}

const classNames = (...values: Array<string | undefined>) =>
  values.filter(Boolean).join(' ').trim();

const RGB_REGEX = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/g;

const animationDataCache = new Map<string, Promise<XmlFrameData>>();

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const fetchAnimationData = (dataUrl: string) => {
  const resolvedDataUrl = resolveAnimationUrl(dataUrl);
  const cachedData = animationDataCache.get(resolvedDataUrl);
  if (cachedData) {
    return cachedData;
  }

  const request = fetch(resolvedDataUrl)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch ${resolvedDataUrl} (${response.status})`);
      }
      return response.text();
    })
    .then((text) => JSON.parse(text) as XmlFrameData)
    .catch((error) => {
      animationDataCache.delete(resolvedDataUrl);
      throw error;
    });

  animationDataCache.set(resolvedDataUrl, request);
  return request;
};

const hexToRgb = (hex: string) => {
  const normalized = hex.replace('#', '');
  const intVal = parseInt(normalized, 16);
  return {
    r: (intVal >> 16) & 255,
    g: (intVal >> 8) & 255,
    b: intVal & 255,
  };
};

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const interpolatePalette = (palette: string[], t: number) => {
  if (palette.length === 1) return hexToRgb(palette[0]);
  const clamped = clamp01(t);
  const scaled = clamped * (palette.length - 1);
  const idx = Math.floor(scaled);
  const frac = scaled - idx;
  const start = hexToRgb(palette[idx]);
  const end = hexToRgb(palette[Math.min(idx + 1, palette.length - 1)]);
  return {
    r: lerp(start.r, end.r, frac),
    g: lerp(start.g, end.g, frac),
    b: lerp(start.b, end.b, frac),
  };
};

const buildColorMapper = (colors: string[], palette: string[]) => {
  const luminances = colors.map((c) => {
    const match = c.match(/(\d+)/g);
    if (!match) return 0;
    const [r, g, b] = match.map(Number);
    return luminance(r, g, b);
  });

  const minLum = Math.min(...luminances, 0);
  const maxLum = Math.max(...luminances, 1);
  const range = Math.max(1, maxLum - minLum);

  return (rgb: string) => {
    const match = rgb.match(/(\d+)/g);
    if (!match) return rgb;
    const [r, g, b] = match.map(Number);
    const lum = luminance(r, g, b);
    const t = clamp01((lum - minLum) / range);
    const mapped = interpolatePalette(palette, t);
    return `rgb(${Math.round(mapped.r)},${Math.round(mapped.g)},${Math.round(mapped.b)})`;
  };
};

function applyGradient(data: XmlFrameData | null, palette: string[]): XmlFrameData | null {
  if (!data?.frames?.length) return data;

  const allColors = new Set<string>();
  data.frames.forEach((frame) => {
    if (!frame.xml) return;
    for (const match of frame.xml.matchAll(RGB_REGEX)) {
      allColors.add(match[0]);
    }
  });

  console.log(
    `[applyGradient] Found ${allColors.size} unique colors in ${data.frames.length} frames`,
    [...allColors].slice(0, 5),
  );

  if (!allColors.size) return data;
  const mapColor = buildColorMapper([...allColors], palette);

  const remapXml = (xml: string) =>
    xml.replace(RGB_REGEX, (_full, r: string, g: string, b: string) =>
      mapColor(`rgb(${r},${g},${b})`),
    );

  return {
    ...data,
    frames: data.frames.map((frame) => ({
      ...frame,
      xml: frame.xml ? remapXml(frame.xml) : frame.xml,
    })),
  };
}

export const ThinkingAnimation = forwardRef<ThinkingAnimationHandle, ThinkingAnimationProps>(
  (
    {
      dataUrl = DEFAULT_THINKING_ANIMATION_URL,
      data,
      autoplay = true,
      loop = true,
      playbackSpeed = 1,
      className,
      style,
      onDone,
      gradient,
    },
    ref,
  ) => {
    // Store raw (unprocessed) data separately from gradient-mapped data
    const [rawData, setRawData] = useState<XmlFrameData | null>(data ?? null);
    const [isFetching, setIsFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);

    useEffect(() => {
      if (data) {
        setRawData(data);
        setFetchError(null);
        setIsFetching(false);
        return;
      }

      if (!dataUrl) {
        setFetchError('No data URL provided');
        return;
      }

      let cancelled = false;
      setIsFetching(true);
      setFetchError(null);

      fetchAnimationData(dataUrl)
        .then((parsed) => {
          if (cancelled) return;
          setRawData(parsed);
          setFetchError(null);
        })
        .catch((error) => {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          setFetchError(message);
          setRawData(null);
        })
        .finally(() => {
          if (!cancelled) {
            setIsFetching(false);
          }
        });

      return () => {
        cancelled = true;
      };
    }, [data, dataUrl]);

    // Apply gradient mapping reactively when gradient prop or raw data changes
    const resolvedData = useMemo(() => {
      if (!rawData) return null;
      if (!gradient?.length) return rawData;
      return applyGradient(rawData, gradient);
    }, [rawData, gradient]);

    const replay = useXmlFrameReplay({
      data: resolvedData,
      autoplay,
      loop,
      playbackSpeed,
      onDone,
    });

    useImperativeHandle(
      ref,
      () => ({
        play: replay.play,
        pause: replay.pause,
        restart: replay.restart,
        seek: replay.seek,
        isPlaying: replay.isPlaying,
      }),
      [replay.play, replay.pause, replay.restart, replay.seek, replay.isPlaying],
    );

    const statusError = fetchError ?? replay.error;

    const wrapperClass = classNames('thinking-animation-wrapper', className);
    const wrapperStyle: CSSProperties = {
      position: 'relative',
      ...style,
    };
    const hasGradient = !!gradient?.length;
    const containerStyle: CSSProperties = {
      width: '100%',
      height: '100%',
      position: 'relative',
      // CSS filter to shift blue SVG to orange when gradient palette is provided
      // invert flips blue→yellow range, then sepia+hue-rotate+saturate tunes to warm orange
      ...(hasGradient
        ? { filter: 'invert(0.5) sepia(1) saturate(3) hue-rotate(330deg) brightness(1.4)' }
        : {}),
    };

    return (
      <div className={wrapperClass} style={wrapperStyle}>
        <div ref={replay.containerRef} style={containerStyle} />
        {statusError && (
          <div
            className="thinking-animation-status"
            aria-live="polite"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.875rem',
              color: '#ff7070',
              pointerEvents: 'none',
            }}
          >
            {statusError}
          </div>
        )}
      </div>
    );
  },
);

ThinkingAnimation.displayName = 'ThinkingAnimation';

export default ThinkingAnimation;
