import { useEffect, useRef } from 'react';
import { liquidMetalFragmentShader, ShaderMount } from '@paper-design/shaders';
import { ArrowRight, Mail, MessageCircle, Globe, Search, Users, Sparkles, Phone } from 'lucide-react';

// Claude Code icon component
const ClaudeCodeIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24">
    <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#D97757" fillRule="nonzero"/>
  </svg>
);

const ShaderLogo = () => {
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
        u_repetition: 0.3,
        u_softness: 0.9,
        u_shiftRed: 0.1,
        u_shiftBlue: 0.1,
        u_distortion: 0,
        u_contour: 0,
        u_angle: 45,
        u_scale: 2,
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
    <div className="relative w-32 h-32 rounded-3xl overflow-hidden shadow-2xl">
      <div
        ref={containerRef}
        className="absolute inset-0"
        style={{ width: '100%', height: '100%' }}
      />
      {/* Rose logo overlay */}
      <div className="absolute inset-0 flex items-center justify-center">
        <svg
          className="w-16 h-16 drop-shadow-lg"
          viewBox="21 62 220 222"
          fill="white"
        >
          <g transform="translate(0,303) scale(0.1,-0.1)">
            <path d="M1276 2378 c-145 -192 -231 -442 -211 -616 8 -68 41 -202 61 -251 8 -19 13 -35 11 -37 -2 -2 -30 7 -62 21 -249 100 -537 54 -784 -124 -36 -25 -69 -49 -75 -53 -17 -11 22 -46 119 -105 163 -101 300 -144 460 -144 92 -1 226 24 301 56 20 8 38 15 39 15 2 0 -10 -39 -25 -87 -69 -213 -58 -395 36 -600 31 -69 136 -237 154 -248 10 -6 114 144 152 220 37 73 75 199 88 293 14 101 1 206 -40 330 -15 48 -27 88 -26 89 1 2 26 -7 55 -18 195 -74 423 -66 611 22 98 46 217 118 245 149 18 20 18 21 -1 35 -177 139 -396 225 -570 225 -79 0 -195 -23 -282 -56 -44 -16 -63 -20 -59 -11 27 72 60 196 68 260 17 132 -17 300 -89 442 -36 72 -124 209 -141 219 -5 4 -21 -8 -35 -26z m40 -935 c7 -46 50 -92 109 -119 27 -13 41 -23 31 -23 -11 -1 -38 -12 -62 -26 -49 -29 -83 -90 -85 -151 -1 -37 -2 -36 -9 13 -4 29 -17 67 -28 85 -22 35 -86 77 -118 79 -11 0 1 9 26 20 79 35 118 90 121 168 1 25 3 28 6 11 2 -14 6 -39 9 -57z"/>
          </g>
        </svg>
      </div>
    </div>
  );
};

// Base capabilities - will be repeated for infinite scroll
const BASE_CAPABILITIES: Array<{ text: string; icon: React.ComponentType<{ className?: string }> | 'claude' }> = [
  { text: 'Make Phone Calls', icon: Phone },
  { text: 'Use Claude Code', icon: 'claude' },
  { text: 'Use a Web Browser', icon: Globe },
  { text: 'Send Emails', icon: Mail },
  { text: 'Text Friends', icon: MessageCircle },
  { text: 'Do Deep Research', icon: Search },
  { text: 'Spawn Infinite Agents', icon: Users },
  { text: 'Live Forever', icon: Sparkles },
];

// Repeat capabilities multiple times for smooth infinite scroll
const CAPABILITIES = [...BASE_CAPABILITIES, ...BASE_CAPABILITIES, ...BASE_CAPABILITIES];

const VerticalCarousel = () => {
  const itemHeight = 52;
  const totalHeight = BASE_CAPABILITIES.length * itemHeight;
  // Duration for one full cycle (all items)
  const cycleDuration = BASE_CAPABILITIES.length * 2; // 2 seconds per item

  return (
    <div className="relative h-[180px] overflow-hidden flex-shrink-0">
      <style>
        {`
          @keyframes tickerScroll {
            0% {
              transform: translateY(0);
            }
            100% {
              transform: translateY(-${totalHeight}px);
            }
          }
        `}
      </style>

      {/* Top fade gradient */}
      <div className="absolute top-0 left-0 right-0 h-12 bg-gradient-to-b from-background to-transparent z-10 pointer-events-none" />

      {/* Bottom fade gradient */}
      <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-background to-transparent z-10 pointer-events-none" />

      {/* Ticker container */}
      <div className="h-full flex items-center justify-center">
        <div
          className="flex flex-col items-start"
          style={{
            animation: `tickerScroll ${cycleDuration}s linear infinite`,
          }}
        >
          {CAPABILITIES.map(({ text, icon: Icon }, idx) => (
            <div
              key={`${text}-${idx}`}
              className="flex items-center gap-3"
              style={{ height: `${itemHeight}px` }}
            >
              <div className="w-10 h-10 rounded-xl bg-surface flex items-center justify-center">
                {Icon === 'claude' ? (
                  <ClaudeCodeIcon />
                ) : (
                  <Icon className="w-5 h-5 text-primary/70" />
                )}
              </div>
              <span className="text-xl font-medium text-foreground whitespace-nowrap">
                {text}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

interface OnboardingWelcomeProps {
  onGetStarted: () => void;
}

const OnboardingWelcome = ({ onGetStarted }: OnboardingWelcomeProps) => {
  const handleGetStarted = () => {
    // Store the prefill query to be picked up when Terminal mounts
    const prefillQuery = "Get me refunds on all of the subscriptions that I am no longer using.";
    localStorage.setItem('onboarding_prefill_query', prefillQuery);
    onGetStarted();
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 py-6 max-h-[calc(100vh-60px)] overflow-hidden">
      <style>
        {`
          @keyframes fadeInUp {
            from {
              opacity: 0;
              transform: translateY(20px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
        `}
      </style>

      {/* Logo with shader */}
      <div
        className="mb-6 flex-shrink-0"
        style={{ animation: 'fadeInUp 0.6s ease-out both' }}
      >
        <ShaderLogo />
      </div>

      {/* Main headline */}
      <div
        className="text-center mb-4 max-w-lg flex-shrink"
        style={{ animation: 'fadeInUp 0.6s ease-out 100ms both' }}
      >
        <h1 className="text-3xl font-semibold text-foreground tracking-tight mb-2">
          Meet Rose
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed whitespace-nowrap">
          A personal superintelligence that can process nearly any request
        </p>
      </div>

      {/* Carousel label */}
      <div
        className="text-center mb-2 flex-shrink-0"
        style={{ animation: 'fadeInUp 0.6s ease-out 200ms both' }}
      >
        <span className="text-sm text-muted-foreground">Rose Agents Can</span>
      </div>

      {/* Vertical carousel */}
      <div
        className="mb-6 flex-shrink"
        style={{ animation: 'fadeInUp 0.6s ease-out 300ms both' }}
      >
        <VerticalCarousel />
      </div>

      {/* Get Started Button */}
      <div
        className="flex-shrink-0"
        style={{ animation: 'fadeInUp 0.6s ease-out 400ms both' }}
      >
        <button
          onClick={handleGetStarted}
          className="group relative px-8 py-4 rounded-2xl bg-primary text-primary-foreground font-medium text-lg shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] flex items-center gap-3"
        >
          Get Started
          <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform duration-200" />
        </button>
      </div>
    </div>
  );
};

export default OnboardingWelcome;
