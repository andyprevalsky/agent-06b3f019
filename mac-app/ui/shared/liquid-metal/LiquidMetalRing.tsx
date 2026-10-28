/**
 * Liquid-metal border ring (the Quick-Query launcher's pill border).
 *
 * Stateless. Absolutely fills its positioned parent with a Rose gradient plus
 * the WebGL liquid-metal shader, both faded left-to-right. Callers place their
 * fill LIQUID_METAL_RING_PX inside it so only the ring shows.
 */

import ShaderTile from './ShaderTile';
import { LIQUID_METAL_GRADIENT, LIQUID_METAL_MASK } from './config';

const LiquidMetalRing = ({ radius }: { radius: number | string }): React.JSX.Element => (
  <div
    aria-hidden
    data-testid="liquid-metal-ring"
    style={{
      position: 'absolute',
      inset: 0,
      borderRadius: radius,
      overflow: 'hidden',
      pointerEvents: 'none',
    }}
  >
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: LIQUID_METAL_GRADIENT,
        maskImage: LIQUID_METAL_MASK,
        WebkitMaskImage: LIQUID_METAL_MASK,
      }}
    />
    <ShaderTile />
  </div>
);

export default LiquidMetalRing;
