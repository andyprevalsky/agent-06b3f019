import { forwardRef, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { liquidMetalFragmentShader, ShaderMount } from '@paper-design/shaders';

interface LiquidWhiteButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

// Layer class names (liquid-white-shader/-chrome/-face/-icon) carry no styles of
// their own; opt-in themes (e.g. the Rose Desktop dark glass) target them.

// CSS variables for white/light version
const CSS_VARS = {
  lightColor: '#e8e8e8',
  darkColor: '#b8b8b8',
  iconColor: '#ffffff',
};

const LiquidWhiteButton = forwardRef<HTMLButtonElement, LiquidWhiteButtonProps>(
  ({ onClick, disabled = false, className, children, size = 'md', ...props }, ref) => {
    const shaderContainerRef = useRef<HTMLDivElement>(null);
    const shaderMountRef = useRef<ShaderMount | null>(null);
    const enableShader = !(typeof window !== 'undefined' && 'api' in window);

    // Scaled down proportionally for button:
    const sizeConfig = {
      sm: 40,
      md: 48,
      lg: 56,
    };

    const baseSize = sizeConfig[size];
    const scale = baseSize / 385; // Scale factor from reference 385px

    // Ring thicknesses (shader: 1px, chrome: 2px)
    const shaderRingThickness = 1;
    const chromeRingThickness = 2;

    const liquidMetalSize = baseSize; // Outer shader ring
    const chromeRingSize = baseSize - shaderRingThickness * 2; // Chrome ring (gradient)
    const innerCircleSize = chromeRingSize - chromeRingThickness * 2; // Inner button face

    useEffect(() => {
      if (!enableShader) return;
      const container = shaderContainerRef.current;
      if (!container) return;

      if (shaderMountRef.current) {
        shaderMountRef.current.dispose();
        shaderMountRef.current = null;
      }

      try {
        // Light/white version - adjusted shader params for brighter appearance.
        shaderMountRef.current = new ShaderMount(
          container,
          liquidMetalFragmentShader,
          {
            u_repetition: 1.5,
            u_softness: 0.6,
            u_shiftRed: 0.2,
            u_shiftBlue: 0.2,
            u_distortion: 0,
            u_contour: 0,
            u_angle: 100,
            u_scale: 1.5,
            u_shape: 1,
            u_offsetX: 0.1,
            u_offsetY: -0.1,
          },
          undefined,
          0.5,
        );
      } catch (error) {
        console.warn('[LiquidWhiteButton] Shader disabled', error);
      }

      return () => {
        if (shaderMountRef.current) {
          shaderMountRef.current.dispose();
          shaderMountRef.current = null;
        }
      };
    }, [enableShader]);

    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'liquid-metal-wrapper liquid-white',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
          className,
        )}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          display: 'inline-block',
        }}
        {...props}
      >
        {/* Shader container */}
        <div
          ref={shaderContainerRef}
          className="liquid-white-shader"
          style={{
            position: 'relative',
            width: `${liquidMetalSize}px`,
            background: enableShader
              ? undefined
              : 'linear-gradient(180deg, #f4f4f4 0%, #cfcfcf 45%, #9f9f9f 100%)',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15), 0 2px 4px rgba(0, 0, 0, 0.1)',
            height: `${liquidMetalSize}px`,
            borderRadius: '50%',
          }}
        >
          {/* Chrome ring - beveled metallic ring between shader and button face */}
          <div
            className="liquid-white-chrome"
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: `${chromeRingSize}px`,
              height: `${chromeRingSize}px`,
              borderRadius: '50%',
              background:
                'linear-gradient(180deg, #f0f0f0 0%, #888 25%, #333 50%, #888 75%, #f0f0f0 100%)',
              zIndex: 1,
            }}
          />

          {/* Inner circle - light gradient button face */}
          <div
            className="liquid-white-face"
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: `${innerCircleSize}px`,
              height: `${innerCircleSize}px`,
              background: `linear-gradient(180deg, ${CSS_VARS.lightColor} 0%, ${CSS_VARS.darkColor} 100%)`,
              borderRadius: '50%',
              boxShadow:
                'inset 0 0.1rem 0.3rem 0.05rem rgba(255, 255, 255, 0.8), inset 0 -0.1rem 0.2rem 0.02rem rgba(0, 0, 0, 0.15)',
              zIndex: 2,
            }}
          />

          {/* Icon container */}
          <div
            className="liquid-white-icon"
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              zIndex: 3,
              fill: CSS_VARS.iconColor,
              color: CSS_VARS.iconColor,
            }}
          >
            {children}
          </div>
        </div>
      </button>
    );
  },
);

LiquidWhiteButton.displayName = 'LiquidWhiteButton';

export default LiquidWhiteButton;
