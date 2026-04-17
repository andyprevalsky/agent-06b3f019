/**
 * Terminal feature — drippiness controls hook.
 *
 * Manages the visual drippiness sliders persisted to localStorage
 * and computes derived CSS styles with non-linear slider mapping.
 */

import { useState, useEffect, useMemo } from 'react';

import { getItem, setItem } from '@/lib/storage';

import { DEFAULT_BG_COLORS, DEFAULT_BLUR, DEFAULT_SHADOW, DEFAULT_BORDER } from '../config';
import type { DripStyles } from '../types';

// ── Non-linear slider mapping functions ───────────────────────────────────

function mapBlurSlider(slider: number): number {
  if (slider <= 5) {
    return (slider / 5) * 2;
  }
  return 2 + ((slider - 5) / 95) * 10;
}

function mapColorsSlider(slider: number): number {
  if (slider <= 10) {
    return (slider / 10) * 5;
  }
  return 5 + ((slider - 10) / 90) * 95;
}

function mapShadowSlider(slider: number): number {
  if (slider <= 20) {
    return (slider / 20) * 20;
  }
  if (slider <= 40) {
    return 20 + ((slider - 20) / 20) * 15;
  }
  return 35 + ((slider - 40) / 60) * 65;
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useDrippiness() {
  const [backgroundColors, setBackgroundColors] = useState(() => {
    const saved = getItem('drippiness-bg-colors');
    return saved ? Number(saved) : DEFAULT_BG_COLORS;
  });
  const [blur, setBlur] = useState(() => {
    const saved = getItem('drippiness-blur');
    return saved ? Number(saved) : DEFAULT_BLUR;
  });
  const [shadowIntensity, setShadowIntensity] = useState(() => {
    const saved = getItem('drippiness-shadow');
    return saved ? Number(saved) : DEFAULT_SHADOW;
  });
  const [borderColor, setBorderColor] = useState(() => {
    const saved = getItem('drippiness-border');
    return saved ? Number(saved) : DEFAULT_BORDER;
  });

  useEffect(() => {
    setItem('drippiness-bg-colors', backgroundColors.toString());
  }, [backgroundColors]);
  useEffect(() => {
    setItem('drippiness-blur', blur.toString());
  }, [blur]);
  useEffect(() => {
    setItem('drippiness-shadow', shadowIntensity.toString());
  }, [shadowIntensity]);
  useEffect(() => {
    setItem('drippiness-border', borderColor.toString());
  }, [borderColor]);

  const dripStyles: DripStyles = useMemo(() => {
    const bgScalar = mapColorsSlider(backgroundColors) / 100;
    const blurPx = mapBlurSlider(blur);
    const shadowScalar = mapShadowSlider(shadowIntensity) / 100;
    const borderScalar = borderColor / 100;

    const borderVal = Math.round(255 - borderScalar * 175);

    return {
      blur: blurPx,
      bgOpacity: 0.6 + bgScalar * 0.35,
      borderOpacity: 0.4 + bgScalar * 0.6,
      shadowIntensity: shadowScalar * 0.25,
      glow: shadowScalar * 16,
      glowOpacity: shadowScalar * 0.08,
      saturation: 1.0 + bgScalar * 0.3,
      brightness: 1.0 + bgScalar * 0.3,
      backgroundColorsScalar: bgScalar,
      borderColorScalar: borderScalar,
      borderRgb: `rgba(${borderVal}, ${borderVal}, ${borderVal}, ${0.5 + borderScalar * 0.5})`,
    };
  }, [backgroundColors, blur, shadowIntensity, borderColor]);

  return {
    backgroundColors,
    setBackgroundColors,
    blur,
    setBlur,
    shadowIntensity,
    setShadowIntensity,
    borderColor,
    setBorderColor,
    dripStyles,
  };
}
