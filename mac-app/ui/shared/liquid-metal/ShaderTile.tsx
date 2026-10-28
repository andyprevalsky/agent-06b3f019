/**
 * Liquid-metal shader layer for LiquidMetalRing.
 *
 * Mounts `@paper-design/shaders`' WebGL-driven `ShaderMount` into a container
 * that fills its parent and disposes the GL context on unmount. Under vitest
 * the `@paper-design/shaders` import is aliased to a no-op stub
 * (`tests/blackbox/stubs/paper-design-shaders.ts`) so blackbox tests can mount
 * it without a WebGL context.
 */

import { useEffect, useRef } from 'react';
import { liquidMetalFragmentShader, ShaderMount } from '@paper-design/shaders';
import {
  LIQUID_METAL_MASK,
  LIQUID_METAL_SHADER_SPEED,
  LIQUID_METAL_SHADER_UNIFORMS,
} from './config';

const ShaderTile = (): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null);
  const shaderRef = useRef<ShaderMount | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    if (shaderRef.current !== null) {
      shaderRef.current.dispose();
      shaderRef.current = null;
    }

    try {
      shaderRef.current = new ShaderMount(
        container,
        liquidMetalFragmentShader,
        LIQUID_METAL_SHADER_UNIFORMS,
        undefined,
        LIQUID_METAL_SHADER_SPEED
      );
    } catch (error) {
      // No WebGL context: the ring's CSS gradient twin still draws the border.
      console.warn('[LiquidMetalRing] Shader disabled', error);
    }

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
        inset: 0,
        maskImage: LIQUID_METAL_MASK,
        WebkitMaskImage: LIQUID_METAL_MASK,
        pointerEvents: 'none',
      }}
    />
  );
};

export default ShaderTile;
