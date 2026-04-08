import { forwardRef, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { liquidMetalFragmentShader, ShaderMount } from '@paper-design/shaders';

interface LiquidBlackButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

// CSS variables from reference
const CSS_VARS = {
  lightColor: '#444',
  darkColor: '#000',
  iconColor: '#65615f',
};

const LiquidBlackButton = forwardRef<HTMLButtonElement, LiquidBlackButtonProps>(
  ({ onClick, disabled = false, className, children, size = 'md', ...props }, ref) => {
    const shaderContainerRef = useRef<HTMLDivElement>(null);
    const shaderMountRef = useRef<ShaderMount | null>(null);

    // Reference sizes in rem (1rem = 10px at 62.5% base):
    // #liquid-metal: 38.5rem = 385px
    // #liquid-metal::before: 35rem = 350px
    // .outline: 39rem = 390px
    // .outline::before padding: 0.5rem = 5px
    // .svg-icon: 10rem = 100px
    //
    // Scaled down proportionally for button:
    const sizeConfig = {
      sm: 40,
      md: 48,
      lg: 56,
    };

    const baseSize = sizeConfig[size];
    const scale = baseSize / 385; // Scale factor from reference 385px

    const liquidMetalSize = baseSize; // 38.5rem equivalent
    const innerCircleSize = Math.round(350 * scale); // 35rem equivalent
    const outlineSize = Math.round(390 * scale); // 39rem equivalent
    const outlinePadding = Math.max(Math.round(5 * scale), 1); // 0.5rem equivalent

    useEffect(() => {
      const container = shaderContainerRef.current;
      if (!container) return;

      if (shaderMountRef.current) {
        shaderMountRef.current.dispose();
        shaderMountRef.current = null;
      }

      shaderMountRef.current = new ShaderMount(
        container,
        liquidMetalFragmentShader,
        {
          u_repetition: 1.5,
          u_softness: 0.5,
          u_shiftRed: 0.3,
          u_shiftBlue: 0.3,
          u_distortion: 0,
          u_contour: 0,
          u_angle: 100,
          u_scale: 1.5,
          u_shape: 1,
          u_offsetX: 0.1,
          u_offsetY: -0.1,
        },
        undefined,
        0.6,
      );

      return () => {
        if (shaderMountRef.current) {
          shaderMountRef.current.dispose();
          shaderMountRef.current = null;
        }
      };
    }, []);

    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'liquid-metal-wrapper',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
          className,
        )}
        style={{
          // No special styles on wrapper, just for click handling
          background: 'none',
          border: 'none',
          padding: 0,
          display: 'inline-block',
        }}
        {...props}
      >
        {/* #liquid-metal */}
        <div
          ref={shaderContainerRef}
          style={{
            position: 'relative',
            width: `${liquidMetalSize}px`,
            height: `${liquidMetalSize}px`,
            borderRadius: '50%',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25), 0 2px 4px rgba(0, 0, 0, 0.15)',
          }}
        >
          {/* #liquid-metal::before - dark inner circle */}
          <div
            style={{
              content: '""',
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: `${innerCircleSize}px`,
              height: `${innerCircleSize}px`,
              background: `linear-gradient(${CSS_VARS.lightColor}, ${CSS_VARS.darkColor})`,
              borderRadius: '50%',
              boxShadow: 'inset 0 0.1rem 0.2rem 0.02rem rgba(255, 255, 255, 0.3)',
              zIndex: 1,
            }}
          />

          {/* .outline */}
          <div
            className="liquid-metal-outline"
            style={{
              position: 'relative',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              width: `${outlineSize}px`,
              height: `${outlineSize}px`,
              borderRadius: '50%',
              zIndex: 1,
            }}
          >
            {/* .outline::before - conic gradient border */}
            <div
              className="liquid-metal-conic-border"
              style={{
                content: '""',
                position: 'absolute',
                inset: 0,
                padding: `${outlinePadding}px`,
                borderRadius: 'inherit',
                background: 'conic-gradient(from 180deg, blue, purple, red, purple, blue)',
                filter: 'grayscale(1)',
                WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                WebkitMaskComposite: 'xor',
                mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                maskComposite: 'exclude',
                transition: 'all 0.3s ease',
              }}
            />

            {/* .svg-icon equivalent - children */}
            <div
              style={{
                fill: CSS_VARS.iconColor,
                color: CSS_VARS.iconColor,
              }}
            >
              {children}
            </div>
          </div>
        </div>
      </button>
    );
  },
);

LiquidBlackButton.displayName = 'LiquidBlackButton';

export default LiquidBlackButton;
