/**
 * Liquid-metal shader backdrop for the launcher pill.
 *
 * Mounts `@paper-design/shaders`' WebGL-driven `ShaderMount` into a flex-
 * filling container and disposes the GL context on unmount. Under vitest
 * the `@paper-design/shaders` import is aliased to a no-op stub
 * (`tests/blackbox/stubs/paper-design-shaders.ts`) so entry-level blackbox
 * tests can mount the launcher without a WebGL context.
 */

import { useEffect, useRef } from 'react';
import { liquidMetalFragmentShader, ShaderMount } from '@paper-design/shaders';
import { LAUNCHER_SHADER_DPR, LAUNCHER_SHADER_UNIFORMS } from '../config';
import type { ShaderTileProps } from '../types';

/** Fills the parent container with the launcher's liquid-metal backdrop. */
const ShaderTile = ({ size }: ShaderTileProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null);
  const shaderRef = useRef<ShaderMount | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    if (shaderRef.current !== null) {
      shaderRef.current.dispose();
      shaderRef.current = null;
    }

    shaderRef.current = new ShaderMount(
      container,
      liquidMetalFragmentShader,
      LAUNCHER_SHADER_UNIFORMS,
      undefined,
      LAUNCHER_SHADER_DPR
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

export default ShaderTile;
