import { useEffect, useRef, useState } from "react";
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
  
  // Orchestrator manages playback; no direct video refs needed here

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
    scrollSpyPauseUntilRef.current = performance.now() + 1500; // ms
    const sentinel = sectionRef.current?.querySelector(`[data-sentinel-index="${index}"]`) as HTMLElement | null;
    if (sentinel) {
      sentinel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };


  return (
    <section id="features" className="py-24 bg-surface relative" ref={sectionRef}>
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
                      className="h-[120vh]"
                      aria-hidden="true"
                    />
                  ))}
                </div>
              </div>
            </div>



            {/* Feature Titles Menu - Right Side */}
            <div className="w-[400px] relative z-20">
              <div className="sticky top-24 space-y-2 bg-surface/30 backdrop-blur-sm rounded-2xl border border-gray-200">
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
                
                {/* Special Waitlist/Pre-order Button */}
                <button
                  onClick={() => {
                    const targetId = earlyAccess ? 'pre-order' : 'waitlist';
                    document.getElementById(targetId)?.scrollIntoView({ 
                      behavior: 'smooth' 
                    });
                  }}
                  className="relative w-full text-left p-4 rounded-lg transition-all duration-300 overflow-hidden border-2 border-transparent"
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC] bg-[length:200%_200%] animate-gradient-rotate rounded-lg">
                  </div>
                  <h4 className="relative font-medium text-sm leading-tight text-white z-10">{earlyAccess ? 'Pre-order' : 'Join the Waitlist'}</h4>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Mobile Layout */}
        <div className="lg:hidden min-h-[600vh] relative">
          {/* Fixed Animation Container - Never moves */}
          <div className="sticky top-24 z-20 flex flex-col items-center space-y-6" style={{ ['--features-sticky-top' as any]: '96px' }}>
            {/* Animation stays in exact same position */}
            <div className="flex items-center justify-center relative" style={{ width: 'min(380px, calc(100vw - 48px))', height: 'clamp(280px, calc(100svh - var(--features-sticky-top, 96px) - 260px), 380px)' }}>
              <div className="w-full h-full rounded-2xl overflow-hidden bg-transparent relative">
                <FeatureVideoStage activeIndex={activeFeature} />
              </div>
            </div>
            
            {/* Content cards in same position */}
            <div className="min-h-[200px] relative" style={{ width: 'min(380px, calc(100vw - 48px))' }}>
              {/* All content cards in same position, fade between them */}
              {features.map((feature, index) => (
                <div 
                  key={feature.title}
                  className={`absolute inset-0 transition-opacity duration-700 ${
                    activeFeature === index ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  <div className="relative bg-background rounded-lg shadow-lg border-2 border-transparent bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC] bg-[length:200%_200%] animate-gradient-rotate p-[1px]">
                    <div className="bg-background rounded-md h-full w-full">
                      {/* Card content */}
                      <div className="p-6">
                      <h3 className="text-xl font-semibold mb-3 text-foreground text-left">{feature.title}</h3>
                      
                      
                      {feature.details.length > 0 && (
                        <ul className="space-y-3 text-left">
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
          </div>
          {/* Scroll sentinels to allocate space for each feature on mobile */}
          <div className="lg:hidden block">
            {features.map((_, i) => (
              <div
                key={`mobile-sentinel-${i}`}
                data-sentinel-index={i}
                className="h-[120vh]"
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