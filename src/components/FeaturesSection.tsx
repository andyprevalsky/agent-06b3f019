import { useEffect, useRef, useState } from "react";
import VideoPlayer from "./VideoPlayer";
import { MemoryGraphAnimation } from "./MemoryGraphAnimation";

const FeaturesSection = () => {
  const [activeFeature, setActiveFeature] = useState(0);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const [isClickScrolling, setIsClickScrolling] = useState(false);
  const [clickedFeature, setClickedFeature] = useState<number | null>(null);
  const [featuresClipPath, setFeaturesClipPath] = useState('inset(100% 0% 0% 0%)');
  const sectionRef = useRef<HTMLDivElement>(null);
  
  // Easing and debouncing for scroll-driven feature changes
  const targetProgressRef = useRef(0); // 0..1 adjusted progress target
  const smoothedProgressRef = useRef(0); // 0..1 eased progress used for index calc
  const inSectionRef = useRef(false);
  const lastChangeRef = useRef(0);
  const activeFeatureRef = useRef(activeFeature);
  const EASING_COEFFICIENT = 0.08; // smaller = smoother/slower
  const MIN_MS_BETWEEN_CHANGES = 500; // debounce interval
  
  // Video refs for restarting animations
  const customizationVideoRef = useRef<HTMLVideoElement>(null);
  const agentEngineVideoRef = useRef<HTMLVideoElement>(null);
  const privacyVideoRef = useRef<HTMLVideoElement>(null);
  const memoryVideoRef = useRef<HTMLVideoElement>(null);
  const mobileCustomizationVideoRef = useRef<HTMLVideoElement>(null);
  const mobileAgentEngineVideoRef = useRef<HTMLVideoElement>(null);
  const mobilePrivacyVideoRef = useRef<HTMLVideoElement>(null);

  // Restart videos when they become active
  useEffect(() => {
    const restartVideo = (videoRef: React.RefObject<HTMLVideoElement>) => {
      if (videoRef.current) {
        videoRef.current.currentTime = 0;
        videoRef.current.play().catch(err => {
          console.log('Video restart failed:', err);
        });
      }
    };

    // Restart appropriate video based on active feature
    switch (activeFeature) {
      case 0: // Customization
        restartVideo(customizationVideoRef);
        restartVideo(mobileCustomizationVideoRef);
        break;
      case 2: // Agent Engine  
        restartVideo(agentEngineVideoRef);
        restartVideo(mobileAgentEngineVideoRef);
        break;
      case 4: // Privacy
        restartVideo(privacyVideoRef);
        restartVideo(mobilePrivacyVideoRef);
        break;
      // Memory animation (case 3) is handled by MemoryGraphAnimation component
    }
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
    let scrollTimeout: NodeJS.Timeout;
    
    const handleScroll = () => {
      if (!sectionRef.current) return;
      
      // Clear the clicked feature override when scrolling stops
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        setClickedFeature(null);
      }, 150);
      
      const sectionElement = sectionRef.current;
      if (!sectionElement) return;
      
      const sectionRect = sectionElement.getBoundingClientRect();
      const sectionTop = sectionRect.top + window.scrollY;
      const sectionHeight = sectionRect.height;
      const viewportCenter = window.scrollY + window.innerHeight / 2;
      
      // Calculate clip-path to constrain grid to features section area
      const viewportHeight = window.innerHeight;
      
      // If section is completely below viewport, hide completely
      if (sectionRect.top >= viewportHeight) {
        setFeaturesClipPath('inset(100% 0% 0% 0%)');
        return;
      }
      
      // If section is completely above viewport, hide completely
      if (sectionRect.bottom <= 0) {
        setFeaturesClipPath('inset(100% 0% 0% 0%)');
        return;
      }
      
      // Calculate visible portion
      const topClip = Math.max(0, sectionRect.top) / viewportHeight * 100;
      const bottomClip = Math.max(0, viewportHeight - sectionRect.bottom) / viewportHeight * 100;
      
      const clipPath = `inset(${topClip}% 0% ${bottomClip}% 0%)`;
      setFeaturesClipPath(clipPath);
      
      if (clickedFeature !== null) return;
      
      // Only update when we're within the features section
      if (viewportCenter >= sectionTop && viewportCenter <= sectionTop + sectionHeight) {
        inSectionRef.current = true;
        // Calculate progress through the section (0 to 1)
        const progress = (viewportCenter - sectionTop) / sectionHeight;

        // Different scrolling behavior for mobile vs desktop
        const isMobile = window.innerWidth < 1024;

        // Compute adjusted progress (0..1) matching existing offsets/scales per device
        const adjustedProgress = isMobile
          ? Math.max(0, Math.min(1, (progress - 0.15) / 0.7))
          : Math.max(0, Math.min(1, (progress - 0.125) / 0.75));

        // Store as target for the smoother animation loop
        targetProgressRef.current = adjustedProgress;
      } else {
        inSectionRef.current = false;
      }
    };

    // Update immediately on scroll, but throttle for performance
    let rafId: number;
    const throttledScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        handleScroll();
        rafId = 0;
      });
    };

    window.addEventListener('scroll', throttledScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', throttledScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [clickedFeature]);

  // Keep ref in sync with state for use inside rAF loop
  useEffect(() => {
    activeFeatureRef.current = activeFeature;
  }, [activeFeature]);

  // rAF loop to ease towards the target progress and debounce index changes
  useEffect(() => {
    let rafId: number;
    const tick = () => {
      // Ease smoothed progress towards target
      const current = smoothedProgressRef.current;
      const target = targetProgressRef.current;
      const next = current + (target - current) * EASING_COEFFICIENT;
      smoothedProgressRef.current = next;

      // Only compute feature index when in section and not click-overridden
      if (inSectionRef.current && clickedFeature === null) {
        const rawIndex = next * features.length;
        const currentIndex = activeFeatureRef.current;
        // Hysteresis: require deeper entry (60%) into next zone
        const stepForward = rawIndex >= currentIndex + 0.6;
        const stepBackward = rawIndex <= currentIndex - 0.6;

        const now = performance.now();
        if (now - lastChangeRef.current >= MIN_MS_BETWEEN_CHANGES) {
          if (stepForward && currentIndex < features.length - 1) {
            const nextIndex = currentIndex + 1;
            lastChangeRef.current = now;
            activeFeatureRef.current = nextIndex;
            setActiveFeature(nextIndex);
          } else if (stepBackward && currentIndex > 0) {
            const nextIndex = currentIndex - 1;
            lastChangeRef.current = now;
            activeFeatureRef.current = nextIndex;
            setActiveFeature(nextIndex);
          }
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [features.length, clickedFeature]);


  const handleFeatureClick = (index: number) => {
    setClickedFeature(index);
    setActiveFeature(index);
    
    const featureElement = sectionRef.current?.querySelector(`[data-index="${index}"]`);
    if (featureElement) {
      featureElement.scrollIntoView({ 
        behavior: 'smooth', 
        block: 'center'
      });
      
      // Clear clicked feature after scroll completes
      setTimeout(() => {
        setClickedFeature(null);
      }, 2000);
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
        style={{ clipPath: featuresClipPath }}
      >
          <div className="grid-3d-wall"></div>
          <div className="grid-3d-floor"></div>
        </div>

        {/* Desktop Layout */}
        <div className="hidden lg:block max-w-7xl mx-auto relative">
          <div className="flex gap-12 min-h-[600vh] relative z-10">
            {/* Fixed Animation Container - Like Menu */}
            <div className="flex-1 flex justify-center relative z-20">
              <div className="w-[560px]">
                <div className="sticky top-48">
                  <div className="w-full h-[520px] flex items-center justify-center relative">
                    <div className="w-full h-full rounded-2xl overflow-hidden bg-transparent relative">
                      {/* Customization Animation */}
                      <div className={`absolute inset-0 transition-opacity duration-700 z-10 ${
                        activeFeature === 0 ? 'opacity-100' : 'opacity-0'
                      }`}>
                        <VideoPlayer
                          ref={customizationVideoRef}
                          src="/navi-customization-animation.webm"
                          className="w-full h-full object-cover"
                          style={{ objectPosition: 'center center' }}
                          objectFit="cover"
                          fallbackContent={
                            <div className="w-full h-full flex items-center justify-center bg-transparent rounded-2xl border border-border/20">
                              <div className="text-center">
                                <div className="w-24 h-24 rounded-full mx-auto mb-4 flex items-center justify-center bg-primary/30">
                                  <div className="w-12 h-12 rounded-full bg-primary/60"></div>
                                </div>
                                <p className="text-muted-foreground text-sm">Customization Animation</p>
                              </div>
                            </div>
                          }
                        />
                      </div>

                      {/* Agent Engine Animation */}
                      <div className={`absolute inset-0 transition-opacity duration-700 z-10 ${
                        activeFeature === 2 ? 'opacity-100' : 'opacity-0'
                      }`}>
                        <VideoPlayer
                          ref={agentEngineVideoRef}
                          src="/navi-engine-animation.webm"
                          className="w-full h-full object-cover"
                          style={{ objectPosition: 'center center' }}
                          objectFit="cover"
                          fallbackContent={
                            <div className="w-full h-full flex items-center justify-center bg-transparent rounded-2xl border border-border/20">
                              <div className="text-center">
                                <div className="w-24 h-24 rounded-full mx-auto mb-4 flex items-center justify-center bg-primary/30">
                                  <div className="w-12 h-12 rounded-full bg-primary/60"></div>
                                </div>
                                <p className="text-muted-foreground text-sm">Agent Engine Animation</p>
                              </div>
                            </div>
                          }
                        />
                      </div>

                      {/* Memory Animation */}
                      <div className={`absolute inset-0 transition-opacity duration-700 z-10 ${
                        activeFeature === 3 ? 'opacity-100' : 'opacity-0'
                      }`}>
                        <MemoryGraphAnimation restart={activeFeature === 3} />
                      </div>

                      {/* Privacy Animation */}
                      <div className={`absolute inset-0 transition-opacity duration-700 z-10 ${
                        activeFeature === 4 ? 'opacity-100' : 'opacity-0'
                      }`}>
                        <VideoPlayer
                          ref={privacyVideoRef}
                          src="/navi-privacy-animation.webm"
                          className="w-full h-full object-contain"
                          style={{ objectPosition: 'center center' }}
                          objectFit="contain"
                          fallbackContent={
                            <div className="w-full h-full flex items-center justify-center bg-transparent rounded-2xl border border-border/20">
                              <div className="text-center">
                                <div className="w-24 h-24 rounded-full mx-auto mb-4 flex items-center justify-center bg-primary/30">
                                  <div className="w-12 h-12 rounded-full bg-primary/60"></div>
                                </div>
                                <p className="text-muted-foreground text-sm">Privacy Animation</p>
                              </div>
                            </div>
                          }
                        />
                      </div>

                      {/* Default/Placeholder Animation */}
                      <div className={`absolute inset-0 transition-opacity duration-700 z-10 ${
                        ![0, 2, 3, 4].includes(activeFeature) ? 'opacity-100' : 'opacity-0'
                      }`}>
                        <div className="w-full h-full flex items-center justify-center bg-transparent rounded-2xl border border-border/20">
                          <div className="text-center">
                            <div className="w-32 h-32 rounded-full mx-auto mb-6 flex items-center justify-center bg-primary/30">
                              <div className="w-16 h-16 rounded-full bg-primary/60"></div>
                            </div>
                            <p className="text-muted-foreground text-base">
                              {features[activeFeature]?.title || 'Feature Animation'}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>



            {/* Feature Titles Menu - Right Side */}
            <div className="w-80 relative z-20">
              <div className="sticky top-24 space-y-2 bg-surface/30 backdrop-blur-sm rounded-2xl border border-gray-200">
                                {features.map((feature, index) => (
                  <div key={feature.title} className="relative" data-index={index}>
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
                
                {/* Special Waitlist Button */}
                <button
                  onClick={() => {
                    document.getElementById('waitlist')?.scrollIntoView({ 
                      behavior: 'smooth' 
                    });
                  }}
                  className="relative w-full text-left p-4 rounded-lg transition-all duration-300 overflow-hidden border-2 border-transparent hover:scale-105"
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC] bg-[length:200%_200%] animate-gradient-rotate rounded-lg">
                  </div>
                  <h4 className="relative font-medium text-sm leading-tight text-white z-10">Join the Waitlist</h4>
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
                {/* All animations in same position, fade between them */}
                <div className={`absolute inset-0 transition-opacity duration-700 z-10 ${
                  activeFeature === 0 ? 'opacity-100' : 'opacity-0'
                }`}>
                  <VideoPlayer
                    ref={mobileCustomizationVideoRef}
                    src="/navi-customization-animation.webm"
                    className="w-full h-full object-cover"
                    style={{ objectPosition: 'center center' }}
                    objectFit="cover"
                    fallbackContent={
                      <div className="w-full h-full flex items-center justify-center bg-transparent rounded-2xl border border-border/20">
                        <div className="text-center">
                          <div className="w-16 h-16 rounded-full mx-auto mb-3 flex items-center justify-center bg-primary/30">
                            <div className="w-8 h-8 rounded-full bg-primary/60"></div>
                          </div>
                          <p className="text-muted-foreground text-xs">Customization</p>
                        </div>
                      </div>
                    }
                  />
                </div>

                <div className={`absolute inset-0 transition-opacity duration-700 z-10 ${
                  activeFeature === 2 ? 'opacity-100' : 'opacity-0'
                }`}>
                  <VideoPlayer
                    ref={mobileAgentEngineVideoRef}
                    src="/navi-engine-animation.webm"
                    className="w-full h-full object-cover"
                    style={{ objectPosition: 'center center' }}
                    objectFit="cover"
                    fallbackContent={
                      <div className="w-full h-full flex items-center justify-center bg-transparent rounded-2xl border border-border/20">
                        <div className="text-center">
                          <div className="w-16 h-16 rounded-full mx-auto mb-3 flex items-center justify-center bg-primary/30">
                            <div className="w-8 h-8 rounded-full bg-primary/60"></div>
                          </div>
                          <p className="text-muted-foreground text-xs">Agent Engine</p>
                        </div>
                      </div>
                    }
                  />
                </div>

                <div className={`absolute inset-0 transition-opacity duration-700 z-10 ${
                  activeFeature === 3 ? 'opacity-100' : 'opacity-0'
                }`}>
                  <MemoryGraphAnimation restart={activeFeature === 3} />
                </div>

                <div className={`absolute inset-0 transition-opacity duration-700 z-10 ${
                  activeFeature === 4 ? 'opacity-100' : 'opacity-0'
                }`}>
                  <VideoPlayer
                    ref={mobilePrivacyVideoRef}
                    src="/navi-privacy-animation.webm"
                    className="w-full h-full object-contain"
                    style={{ objectPosition: 'center center' }}
                    objectFit="contain"
                    fallbackContent={
                      <div className="w-full h-full flex items-center justify-center bg-transparent rounded-2xl border border-border/20">
                        <div className="text-center">
                          <div className="w-16 h-16 rounded-full mx-auto mb-3 flex items-center justify-center bg-primary/30">
                            <div className="w-8 h-8 rounded-full bg-primary/60"></div>
                          </div>
                          <p className="text-muted-foreground text-xs">Privacy</p>
                        </div>
                      </div>
                    }
                  />
                </div>

                <div className={`absolute inset-0 transition-opacity duration-700 z-10 ${
                  ![0, 2, 3, 4].includes(activeFeature) ? 'opacity-100' : 'opacity-0'
                }`}>
                  <div className="w-full h-full flex items-center justify-center bg-transparent rounded-2xl border border-border/20">
                    <div className="text-center">
                      <div className="w-20 h-20 rounded-full mx-auto mb-4 flex items-center justify-center bg-primary/30">
                        <div className="w-10 h-10 rounded-full bg-primary/60"></div>
                      </div>
                      <p className="text-muted-foreground text-sm">
                        {features[activeFeature]?.title || 'Features'}
                      </p>
                    </div>
                  </div>
                </div>
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
        </div>
      </div>
    </section>
  );
};

export default FeaturesSection;