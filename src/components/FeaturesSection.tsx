import { useEffect, useRef, useState } from "react";
import VideoPlayer from "./VideoPlayer";

const FeaturesSection = () => {
  const [activeFeature, setActiveFeature] = useState(0);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const [isClickScrolling, setIsClickScrolling] = useState(false);
  const [clickedFeature, setClickedFeature] = useState<number | null>(null);
  const [featuresClipPath, setFeaturesClipPath] = useState('inset(100% 0% 0% 0%)');
  const sectionRef = useRef<HTMLDivElement>(null);
  
  // Video refs for restarting animations
  const customizationVideoRef = useRef<HTMLVideoElement>(null);
  const agentEngineVideoRef = useRef<HTMLVideoElement>(null);
  const privacyVideoRef = useRef<HTMLVideoElement>(null);
  const mobileCustomizationVideoRef = useRef<HTMLVideoElement>(null);
  const mobileAgentEngineVideoRef = useRef<HTMLVideoElement>(null);
  const mobilePrivacyVideoRef = useRef<HTMLVideoElement>(null);

  const features = [
    {
      title: "Frontier AI at Your Fingertips",
      description: "Navi is a hardware device that brings frontier LLMs closer than ever before",
      details: [
        "Navi makes frontier reasoning models milliseconds away",
        "Access state-of-the-art reasoning models in an instant to keep you on the go and building momentum"
      ]
    },
    {
      title: "Fully Customizable",
      description: "Change the system prompt, voice model, chat providers & tools to tune Navi to your liking",
      details: [
        "Customize system prompts, voice models, and chat model providers",
        "Connect tools to tune Navi to your liking",
        "Pick from a marketplace of hand-crafted presets to build from",
        "Create your perfect AI companion"
      ]
    },
    {
      title: "Seamless Conversations",
      description: "Navi is optimized to be blazing fast to make conversations feel seamless",
      details: [
        "AI models trained specifically to tell Navi when to talk and when not to",
        "Navi feels more lifelike than anything else out there",
        "Natural conversation flow without awkward interruptions"
      ]
    },
    {
      title: "Spawn Agents for Any Problem",
      description: "Navi handles thousands of concurrent agents that interface with the real world",
      details: [
        "Agents can interface with the internet, hook into socials, and poll real-world oracles",
        "Iterate towards any future outcome, whether you want to never miss a meal again or get your dream job",
        "Continuously measure, learn, and build its way to any of your life goals",
        "As AI gets better, the level of abstraction of problems that can be solved increases",
        "Navi isn't just a smart speaker, it's also an engine for getting things done."
      ]
    },
    {
      title: "Navi Grows With You",
      description: "A robust, state-of-the-art memory system that learns to be your perfect companion",
      details: [
        "Remembers your preferences, anniversaries, and important information",
        "AI meetup summaries and meal prep lists",
        "Regular check-ins and relationship tracking",
        "Evolving personality that adapts to your needs"
      ]
    },
    {
      title: "Privacy First",
      description: "Navi stores no data from your conversations, ensuring complete privacy",
      details: [
        "All data is streamed directly to frontier AI model providers anonymously",
        "Navi does not passively listen to conversations",
        "Triggered only on wake word 'Hi Navi'",
        "Complete transparency in our commitment to your privacy"
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
        // Calculate progress through the section (0 to 1)
        const progress = (viewportCenter - sectionTop) / sectionHeight;
        
        // Divide into equal zones for each feature
        const featureIndex = Math.floor(progress * features.length);
        const clampedIndex = Math.max(0, Math.min(features.length - 1, featureIndex));
        
        setActiveFeature(clampedIndex);
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

  // Restart videos when they become active
  useEffect(() => {
    const restartVideo = (videoRef: React.RefObject<HTMLVideoElement>) => {
      if (videoRef.current) {
        videoRef.current.currentTime = 0;
        videoRef.current.play().catch(() => {
          // If autoplay fails, that's okay
        });
      }
    };

    // Restart appropriate videos based on active feature
    if (activeFeature === 1) {
      restartVideo(customizationVideoRef);
      restartVideo(mobileCustomizationVideoRef);
    } else if (activeFeature === 3) {
      restartVideo(agentEngineVideoRef);
      restartVideo(mobileAgentEngineVideoRef);
    } else if (activeFeature === 5) {
      restartVideo(privacyVideoRef);
      restartVideo(mobilePrivacyVideoRef);
    }
  }, [activeFeature]);

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
        <div className="text-center mb-16">
          <h2 className="text-5xl font-light tracking-tight mb-6 reveal-up">
            <span className="gradient-text">Features</span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto reveal-up reveal-delay-1">
            Designed for power users who demand flexibility, privacy, and performance
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
          <div className="flex gap-12 min-h-[300vh] relative z-10">
            {/* Fixed Animation Container - Like Menu */}
            <div className="flex-1 flex justify-center relative z-20">
              <div className="w-[560px]">
                <div className="sticky top-48">
                  <div className="w-full h-[520px] flex items-center justify-center relative">
                    <div className="w-full h-full rounded-2xl overflow-hidden bg-transparent relative">
                      {/* Customization Animation */}
                      <div className={`absolute inset-0 transition-opacity duration-700 z-10 ${
                        activeFeature === 1 ? 'opacity-100' : 'opacity-0'
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
                        activeFeature === 3 ? 'opacity-100' : 'opacity-0'
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

                      {/* Privacy Animation */}
                      <div className={`absolute inset-0 transition-opacity duration-700 z-10 ${
                        activeFeature === 5 ? 'opacity-100' : 'opacity-0'
                      }`}>
                        <VideoPlayer
                          ref={privacyVideoRef}
                          src="/navi-privacy-animation-2.webm"
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
                        ![1, 3, 5].includes(activeFeature) ? 'opacity-100' : 'opacity-0'
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
              <div className="sticky top-24 space-y-8 bg-surface/30 backdrop-blur-sm rounded-2xl border border-gray-200">
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
                          <p className="text-sm text-muted-foreground leading-relaxed mb-4">{feature.description}</p>
                          
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
        <div className="lg:hidden min-h-[300vh] relative">
          {/* Fixed Animation Container - Never moves */}
          <div className="sticky top-24 z-20 flex flex-col items-center space-y-6">
            {/* Animation stays in exact same position */}
            <div className="w-[400px] h-[380px] flex items-center justify-center relative">
              <div className="w-full h-full rounded-2xl overflow-hidden bg-transparent relative">
                {/* All animations in same position, fade between them */}
                <div className={`absolute inset-0 transition-opacity duration-700 z-10 ${
                  activeFeature === 1 ? 'opacity-100' : 'opacity-0'
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
                  activeFeature === 3 ? 'opacity-100' : 'opacity-0'
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
                  activeFeature === 5 ? 'opacity-100' : 'opacity-0'
                }`}>
                  <VideoPlayer
                    ref={mobilePrivacyVideoRef}
                    src="/navi-privacy-animation-2.webm"
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
                  ![1, 3, 5].includes(activeFeature) ? 'opacity-100' : 'opacity-0'
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
            
            {/* Text stays in exact same position */}
            <div className="w-[320px] min-h-[200px] relative">
              {/* All text content in same position, fade between them */}
              {features.map((feature, index) => (
                <div 
                  key={feature.title}
                  className={`absolute inset-0 transition-opacity duration-700 ${
                    activeFeature === index ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  <div className="text-center px-4">
                    <h3 className="text-xl font-semibold mb-3 text-foreground">{feature.title}</h3>
                    <p className="text-sm text-muted-foreground mb-4 leading-relaxed">{feature.description}</p>
                    
                    {feature.details.length > 0 && (
                      <ul className="space-y-2 text-left">
                        {feature.details.map((detail, detailIndex) => (
                          <li key={detailIndex} className="flex items-start space-x-2">
                            <div className="w-1 h-1 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                            <span className="text-xs text-foreground/80 leading-relaxed">{detail}</span>
                          </li>
                        ))}
                      </ul>
                    )}
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