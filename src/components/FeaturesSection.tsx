import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import FeatureVideoStage from "./FeatureVideoStage";
import { isEarlyAccessEnabled } from "@/lib/utils";

const FeaturesSection = () => {
  const [activeFeature, setActiveFeature] = useState(0);
  const [featuresClipPath, setFeaturesClipPath] = useState('inset(99% 0% 0% 0%)');
  const [gridOffsetX, setGridOffsetX] = useState(0);
  const sectionRef = useRef<HTMLDivElement>(null);
  const observersReadyRef = useRef(false);
  // Temporarily pause scroll-driven highlight updates after a click
  const scrollSpyPauseUntilRef = useRef<number>(0);
  const earlyAccess = isEarlyAccessEnabled();
  const isMobile = useIsMobile();
  const [isNarrowPhone, setIsNarrowPhone] = useState<boolean>(false);
  const [isShortHeight, setIsShortHeight] = useState<boolean>(false);
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 380px)');
    const onChange = () => setIsNarrowPhone(mql.matches);
    onChange();
    try { mql.addEventListener('change', onChange); } catch { /* Safari */ mql.addListener(onChange as any); }
    return () => { try { mql.removeEventListener('change', onChange); } catch { mql.removeListener(onChange as any); } };
  }, []);
  useEffect(() => {
    const mqlH = window.matchMedia('(max-height: 750px)');
    const onChangeH = () => setIsShortHeight(mqlH.matches);
    onChangeH();
    try { mqlH.addEventListener('change', onChangeH); } catch { /* Safari */ mqlH.addListener(onChangeH as any); }
    return () => { try { mqlH.removeEventListener('change', onChangeH); } catch { mqlH.removeListener(onChangeH as any); } };
  }, []);
  
  // Orchestrator manages playback; no direct video refs needed here

  // Navi logo gradient stops (left-to-right) for sequential card backgrounds
  const logoStops = ['#FE7503', '#FC585C', '#FD5776', '#E062CC', '#A76CED', '#7A6BEC'];
  const getStopForIndex = (index: number) => logoStops[index % logoStops.length];
  const hexToRgb = (hex: string) => {
    const clean = hex.replace('#', '');
    const bigint = parseInt(clean, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return { r, g, b };
  };
  const rgbaString = (hex: string, alpha: number) => {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };
  const darkenHex = (hex: string, amount: number) => {
    const { r, g, b } = hexToRgb(hex);
    const k = Math.max(0, Math.min(1, amount));
    const dr = Math.max(0, Math.round(r * (1 - k)));
    const dg = Math.max(0, Math.round(g * (1 - k)));
    const db = Math.max(0, Math.round(b * (1 - k)));
    const toHex = (v: number) => v.toString(16).padStart(2, '0');
    return `#${toHex(dr)}${toHex(dg)}${toHex(db)}`;
  };
  const mixWithWhite = (hex: string, t: number) => {
    const { r, g, b } = hexToRgb(hex);
    const k = Math.max(0, Math.min(1, t));
    const mr = Math.round(r * (1 - k) + 255 * k);
    const mg = Math.round(g * (1 - k) + 255 * k);
    const mb = Math.round(b * (1 - k) + 255 * k);
    const toHex = (v: number) => v.toString(16).padStart(2, '0');
    return `#${toHex(mr)}${toHex(mg)}${toHex(mb)}`;
  };

  // Lux neutral palette accents
  const pearlBlue = '#F8FAFF'; // slightly less blue, pearl-white tint
  const heroBlack = '#272725'; // match hero section dark tone

  const getIconForIndex = (index: number) => {
    switch (index) {
      case 0: return 'customize.svg';
      case 1: return 'seamless.svg';
      case 2: return 'agent.svg';
      case 3: return 'grow.svg';
      case 4: return 'privacy.svg';
      default: return 'seamless.svg';
    }
  };

  // Fit text to container (mobile/tablet): scale typography down until it fits
  const textContainerRefs = useRef<Array<HTMLDivElement | null>>([]);
  const textContentRefs = useRef<Array<HTMLUListElement | null>>([]);
  const [textScales, setTextScales] = useState<number[]>(() => new Array(5).fill(1));
  useLayoutEffect(() => {
    const isDesktop = window.matchMedia('(min-width: 1024px)').matches;
    if (isDesktop) return; // desktop uses different layout
    const idx = activeFeature;
    const container = textContainerRefs.current[idx];
    const content = textContentRefs.current[idx];
    if (!container || !content) return;
    // Try decreasing scale until content fits or min scale reached
    let scale = 1;
    const minScale = 0.85;
    const step = 0.04;
    // Limit attempts to avoid long loops
    let attempts = 0;
    while (attempts < 8) {
      // Apply temporary inline styles to content for measurement
      content.style.setProperty('--title-scale', String(scale));
      content.style.setProperty('--body-scale', String(scale));
      // Force sync measurement after style change
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      content.offsetHeight;
      const overflows = content.scrollHeight > container.clientHeight;
      if (!overflows || scale <= minScale) break;
      scale = Math.max(minScale, scale - step);
      attempts += 1;
    }
    setTextScales(prev => {
      const next = [...prev];
      next[idx] = scale;
      return next;
    });
    return () => {
      try {
        content?.style.removeProperty('--title-scale');
        content?.style.removeProperty('--body-scale');
      } catch {}
    };
  }, [activeFeature]);

  const features = [
    {
      title: "Fully Customizable",
      description: "",
      details: [
        "Change the LLM provider, System Prompt & Voice to create your perfect AI companion.",
        "Connect your own tools to Navi through MCPs, or use tools shared by other devs in our marketplace.",
        "Navi comes with prebuilt presets to get you up and running with STOA models in an instant."
      ]
    },
    {
      title: "Seamless Conversations",
      description: "",
      details: [
        "Sub-800 ms responses keep every exchange natural and fluid.",
        "Custom models fine-tuned for smooth interruption handling and turn-taking.",
        "Custom voice pipeline engineered by veterans of top voice-AI companies."
      ]
    },
    {
      title: "Agent Enabled",
      description: "",
      details: [
        "Navi agents break down, measure & iterate towards any long-term goal.",
        "Integrated with phone calling, web search, email/SMS, and user-authorized payments, so Navi can take real-world actions on your behalf.",
        "Each agent runs on a STOA agent harness, so that agents maintain long term context, are fault tolerant & can share learnings across sessions."
      ]
    },
    {
      title: "Navi Grows With You",
      description: "",
      details: [
        "After each conversation, Navi extracts key entity information to keep track of your most important relationships, events, and ideas.",
        "Navi's personality evolves to match your communication style.",
        "Time-based queries keep Navi working in the background, constantly refining its understanding of your world and ideating on ways to help you grow."
      ]
    },
    {
      title: "Privacy First",
      description: "",
      details: [
        <>
          Your conversations stay private. Navi never stores or sells your data. View our privacy policy{" "}
          <a 
            href="/privacy" 
            className="text-primary hover:text-primary/80 underline transition-colors"
          >
            here.
          </a>
        </>,
        "Navi does not passively listen, and is designed to only trigger active listening according to the customizable wake word, \"Hi Navi\".",
        "Audio data & transcriptions are streamed directly, securely & anonymously to AI providers."
      ]
    }
  ];

  useEffect(() => {
    // Clip-path updater for 3D grid background. No debouncing of feature state.
    const handleScroll = () => {
      if (!sectionRef.current) return;
      const sectionElement = sectionRef.current;
      const sectionRect = sectionElement.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const sectionHeight = sectionElement.offsetHeight || 1;
      
      // Pre-reveal margin so the grid paints early, with a stronger effect on small screens
      const isSmall = window.matchMedia('(max-width: 1024px)').matches;
      const preRevealPx = viewportHeight * (isSmall ? 0.6 : 0.25);
      const topClip = Math.max(0, (sectionRect.top - preRevealPx)) / viewportHeight * 100;
      const bottomClip = Math.max(0, (viewportHeight - sectionRect.bottom)) / viewportHeight * 100;
      setFeaturesClipPath(`inset(${topClip}% 0% ${bottomClip}% 0%)`);

      // Smooth horizontal scan tied to scroll
      const scrolledWithin = Math.min(Math.max(-sectionRect.top, 0), sectionHeight);
      const progress = scrolledWithin / sectionHeight; // 0..1 across the section
      const offset = (progress * 1200) + (window.scrollY * 0.1);
      setGridOffsetX(offset);
    };

    let rafId = 0 as unknown as number;
    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        handleScroll();
        rafId = 0 as unknown as number;
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    handleScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  // Set active feature when sentinels enter view
  useEffect(() => {
    if (!sectionRef.current || observersReadyRef.current) return;
    const sectionEl = sectionRef.current;
    const sentinels = Array.from(sectionEl.querySelectorAll('[data-sentinel-index]')) as HTMLElement[];
    if (sentinels.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Ignore updates while a manual click override is active
        if (performance.now() < scrollSpyPauseUntilRef.current) return;
        // Pick the entry most centered/in view
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => (b.intersectionRatio || 0) - (a.intersectionRatio || 0));
        if (visible.length > 0) {
          const idxAttr = (visible[0].target as HTMLElement).getAttribute('data-sentinel-index');
          const idx = idxAttr ? parseInt(idxAttr, 10) : NaN;
          if (!Number.isNaN(idx)) setActiveFeature(idx);
        }
      },
      {
        // Broader thresholds and a centered root margin band make switching smoother
        threshold: [0, 0.25, 0.5, 0.75, 1],
        rootMargin: '-40% 0px -40% 0px'
      }
    );

    sentinels.forEach(s => observer.observe(s));
    observersReadyRef.current = true;
    return () => observer.disconnect();
  }, []);


  const handleFeatureClick = (index: number) => {
    setActiveFeature(index);
    // Pause scroll-based updates to avoid highlight flicker while smooth-scrolling
    scrollSpyPauseUntilRef.current = performance.now() + 300; // ms
    const sentinel = sectionRef.current?.querySelector(`[data-sentinel-index="${index}"]`) as HTMLElement | null;
    if (sentinel) {
      sentinel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Scroll to a feature sentinel and let the IntersectionObserver set activeFeature naturally
  const scrollToFeature = (index: number) => {
    const node = sectionRef.current;
    if (!node) return;
    const all = Array.from(node.querySelectorAll(`[data-sentinel-index="${index}"]`)) as HTMLElement[];
    // Prefer the visible sentinel (not display:none and with layout)
    let sentinel = all.find(el => {
      const cs = window.getComputedStyle(el);
      return cs.display !== 'none' && el.offsetParent !== null;
    }) || all[0] || null;
    if (!sentinel) return;
    const rect = sentinel.getBoundingClientRect();
    const targetY = window.scrollY + rect.top + 1; // nudge to ensure IO band overlap
    try {
      window.scrollTo({ top: targetY, behavior: 'smooth' });
    } catch {
      window.scrollTo(0, targetY);
    }
  };


  return (
    <section id="features" className="py-24 bg-background relative" ref={sectionRef}>
      <div className="container mx-auto px-6">
        <div className="relative z-10 text-center mb-16">
          <h2 className="text-5xl font-light tracking-tight mb-6 reveal-up">
            <span className="gradient-text">Features</span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto reveal-up reveal-delay-1">
            Navi is a hackable smart speaker designed for developers
          </p>
        </div>
        
              {/* 3D Grid Background - Fixed with Clip Path */}
      <div 
        className="grid-3d-background"
        style={{ clipPath: featuresClipPath, willChange: 'clip-path, background-position' }}
      >
          <div className="grid-3d-wall" style={{ backgroundPosition: `${-gridOffsetX}px 0px` }}></div>
          <div className="grid-3d-floor" style={{ backgroundPosition: `${-gridOffsetX}px 0px` }}></div>
        </div>
        {/* Top fade to ensure grid never peeks above and bottom bleed under waitlist */}
        <div className="pointer-events-none absolute top-0 left-0 right-0 h-24 z-20 bg-gradient-to-b from-background to-transparent"></div>
        <div className="pointer-events-none absolute -bottom-24 left-0 right-0 h-24 z-0 bg-gradient-to-t from-background to-transparent"></div>

        {/* Desktop Layout */}
        <div className="hidden lg:block max-w-7xl mx-auto relative">
          <div className="flex gap-12 min-h-[600vh] relative z-10">
            {/* Fixed Animation Container - Like Menu */}
            <div className="flex-1 flex justify-center relative z-20">
              <div className="" style={{ width: '840px' }}>
                <div className="sticky top-24">
                  <div className={`w-full h-[780px] flex items-center justify-center relative`}>
                    <FeatureVideoStage activeIndex={activeFeature} />
                  </div>
                </div>
                {/* Scroll sentinels to allocate space for each feature on desktop */}
                <div className="lg:block hidden">
                  {features.map((_, i) => (
                    <div
                      key={`desktop-sentinel-${i}`}
                      data-sentinel-index={i}
                      id={`feature-sentinel-${i}`}
                      className="h-[180vh]"
                      aria-hidden="true"
                    />
                  ))}
                </div>
              </div>
            </div>



            {/* Feature Titles Menu - Right Side */}
            <div className="w-[400px] relative z-20">
              <div className="sticky top-24">
                <div className="bg-surface/30 backdrop-blur-sm rounded-2xl border border-gray-200">
                {features.map((feature, index) => (
                  <div key={feature.title} className="relative">
                    {/* Unified card structure for all items */}
                    <div className={`relative overflow-hidden transition-all duration-500 ${
                      activeFeature === index ? 'border-2 border-transparent rounded-lg' : 'border-2 border-transparent rounded-lg'
                    }`}>
                      {/* Gradient border for active item */}
                      {activeFeature === index && (
                        <div className="absolute inset-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC] bg-[length:200%_200%] animate-gradient-rotate rounded-lg p-[2px]">
                          <div className="w-full h-full bg-background rounded-md"></div>
                        </div>
                      )}
                      
                      {/* Header button */}
                      <button
                        onClick={() => handleFeatureClick(index)}
                        className={`relative w-full text-left p-4 transition-all duration-500 ${
                          activeFeature === index
                            ? 'text-foreground'
                            : 'hover:bg-muted/50 text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <h4 className="relative font-medium text-sm leading-tight">{feature.title}</h4>
                      </button>
                      
                      {/* Expandable content with proper animation timing */}
                      <div 
                        className={`relative overflow-hidden transition-all duration-700 ease-in-out ${
                          activeFeature === index 
                            ? 'max-h-96 opacity-100 delay-700' 
                            : 'max-h-0 opacity-0 delay-0'
                        }`}
                      >
                        <div className="relative px-4 pb-4">
                          
                          
                          {feature.details.length > 0 && (
                            <ul className="space-y-3">
                              {feature.details.map((detail, detailIndex) => (
                                <li key={detailIndex} className="flex items-start space-x-3">
                                  <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                                  <span className="text-sm text-foreground/80 leading-relaxed">{detail}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                </div>

                {/* Special Waitlist/Pre-order Button - GRADIENT (desktop) */}
                <button
                  onClick={() => {
                    const targetId = earlyAccess ? 'pre-order' : 'waitlist';
                    if (window.location.pathname === '/') {
                      document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth' });
                    } else {
                      window.location.href = earlyAccess ? `/?earlyaccess#${targetId}` : `/#${targetId}`;
                    }
                  }}
                  className="relative w-full text-left p-4 rounded-lg transition-all duration-300 overflow-hidden border-2 border-transparent mt-2"
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC] bg-[length:200%_200%] animate-gradient-rotate rounded-lg"></div>
                  <h4 className="relative font-medium text-sm leading-tight text-white z-10">{earlyAccess ? 'Pre-order' : 'Join the Waitlist'}</h4>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Mobile/Tablet Layout (applies up to lg) */}
        <div className="lg:hidden min-h-[600vh] relative">
          {/* Fixed Animation Container - Never moves */}
          <div className="sticky top-24 z-20 flex flex-col items-center space-y-6" style={{ ['--features-sticky-top' as any]: '96px' }}>
            {/* Animation stays in exact same position */}
            <div className="flex items-center justify-center relative" style={{ width: 'min(420px, calc(100vw - 24px))', height: 'clamp(240px, calc((100vh - var(--features-sticky-top, 96px) - 72px) * 0.5), 380px)' }}>
              <div className="w-full h-full rounded-2xl overflow-hidden bg-transparent relative">
                <FeatureVideoStage activeIndex={activeFeature} />
              </div>
            </div>
            
            {/* Content cards in same position */}
            <div className="relative" style={{ width: 'min(420px, calc(100vw - 24px))', height: 'clamp(240px, calc((100vh - var(--features-sticky-top, 96px) - 72px) * 0.5), 380px)' }}>
              {/* All content cards in same position, fade between them */}
              {features.map((feature, index) => (
                <div 
                  key={feature.title}
                  className={`absolute inset-0 transition-opacity duration-700 ${
                    activeFeature === index ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  <div className="relative h-full w-full">
                    <div 
                      className="h-full w-full border rounded-none shadow-lg"
                      style={{ 
                        backgroundColor: (activeFeature === index) ? pearlBlue : '#ffffff',
                        transition: 'background-color 2000ms ease',
                        borderColor: heroBlack
                      }}
                    >
                      {/* Card content */}
                      <div ref={el => (textContainerRefs.current[index] = el)} className="p-6">
                      <div className="flex items-center gap-3" style={{ marginBottom: (!isShortHeight ? '1.25rem' : '0.75rem') }}>
                        <div
                          className="border p-1 flex items-center justify-center"
                          style={{
                            width: '2.25rem',
                            height: '2.25rem',
                            backgroundColor: (activeFeature === index) ? heroBlack : '#d1d5db',
                            transition: 'background-color 2000ms ease',
                            borderColor: heroBlack
                          }}
                        >
                          <img 
                            src={`/${getIconForIndex(index)}`} 
                            alt="" 
                            className="w-full h-full object-contain"
                            style={{ filter: 'brightness(0) invert(1)', transition: 'none' }}
                          />
                        </div>
                        <h3 className="font-semibold text-foreground text-left" style={{ fontSize: `calc(${isMobile ? 1.125 : 1.25}rem * ${textScales[index] || 1})`, lineHeight: `calc(${isMobile ? 1.6 : 1.75}rem * ${textScales[index] || 1})` }}>{feature.title}</h3>
                      </div>
                      
                      
                      {feature.details.length > 0 && (
                        <ul ref={el => (textContentRefs.current[index] = el)} className="space-y-3 text-left" style={{ fontSize: `calc(${isMobile ? 0.95 : 0.875}rem * ${textScales[index] || 1})`, lineHeight: `calc(${isMobile ? 1.45 : 1.375}rem * ${textScales[index] || 1})` }}>
                          {(isMobile ? (index === 2 ? feature.details.slice(0, 2) : (isShortHeight ? feature.details.slice(0, 2) : feature.details.slice(0, 3))) : feature.details).map((detail, detailIndex) => (
                            <li key={detailIndex} className="flex items-start space-x-3">
                              <div 
                                className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 transition-colors duration-1000"
                                style={{ backgroundColor: (activeFeature === index) ? heroBlack : '#d1d5db' }}
                              ></div>
                              <span className="text-foreground/80 leading-relaxed">{
                                (index === 4 && detailIndex === 1)
                                  ? 'Navi does not passively listen, active listening is enabled only by the customizable wake word, "Hi Navi".'
                                  : (isMobile && index === 3 && detailIndex === 2)
                                    ? 'Time based queries keep navi working in the background.'
                                    : detail
                              }</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      </div>
                    </div>
                  </div>
                  {/* Bottom-right bounce arrow */}
                  <div className="absolute right-2 bottom-2 z-30 pointer-events-auto">
                    <button 
                      type="button"
                      className="w-8 h-4 flex items-center justify-center animate-slow-bounce-half pointer-events-auto"
                      aria-label="Scroll to next feature"
                      onClick={() => {
                        if (activeFeature >= features.length - 1) {
                          const targetId = earlyAccess ? 'pre-order' : 'waitlist';
                          if (window.location.pathname === '/') {
                            document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth' });
                          } else {
                            window.location.href = earlyAccess ? `/?earlyaccess#${targetId}` : `/#${targetId}`;
                          }
                        } else {
                          scrollToFeature(activeFeature + 1);
                        }
                      }}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#272725" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {/* Removed measurement nodes; we now use 50/50 split with scrollable content */}
            {/* Dots pagination */}
            <div className="flex items-center justify-center gap-2" style={{ width: 'min(380px, calc(100vw - 48px))' }}>
              {features.map((_, i) => {
                const isActive = activeFeature === i;
                const activeBg = heroBlack;
                return (
                  <button
                    key={`dot-m-${i}`}
                    aria-label={`Go to feature ${i + 1}`}
                    onClick={() => scrollToFeature(i)}
                    className={`h-1.5 transition-all duration-300 ${isActive ? 'w-6 rounded-md' : 'w-1.5 rounded-full'}`}
                    style={{ backgroundColor: isActive ? activeBg : '#d1d5db' }}
                  />
                );
              })}
            </div>
          </div>
          {/* Scroll sentinels to allocate space for each feature on mobile/tablet */}
          <div className="lg:hidden block">
            {features.map((_, i) => (
              <div
                key={`mobile-sentinel-${i}`}
                data-sentinel-index={i}
                id={`feature-sentinel-${i}`}
                className="h-[180vh]"
                aria-hidden="true"
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default FeaturesSection;