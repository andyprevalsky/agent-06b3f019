/**
 * Liquid-metal ring styling shared by the Quick-Query launcher pill and the
 * main window's update chip, so both borders render from one source.
 */

/** Uniforms for the `@paper-design/shaders` liquid-metal fragment shader. */
export const LIQUID_METAL_SHADER_UNIFORMS = {
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
};

/**
 * Animation speed passed to ShaderMount (0 would freeze it). The launcher's
 * slow 0.5 drift is the "liquid" look the update chip reuses.
 */
export const LIQUID_METAL_SHADER_SPEED = 0.5;

/** Left-to-right fade applied to both the shader and its CSS gradient twin. */
export const LIQUID_METAL_MASK =
  'linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0) 100%)';

/** Rose gradient under the shader — keeps the ring visible without WebGL. */
export const LIQUID_METAL_GRADIENT =
  'linear-gradient(115deg, #FE7503 0%, #FC585C 28%, #E062CC 58%, #7A6BEC 100%)';

/** Ring thickness: the inner fill sits this many px inside the ring. */
export const LIQUID_METAL_RING_PX = 2;
