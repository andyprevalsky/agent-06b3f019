import { useEffect, useRef, useState } from "react";

const FeaturesSection = () => {
  const [activeFeature, setActiveFeature] = useState(0);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const [isClickScrolling, setIsClickScrolling] = useState(false);
  const [clickedFeature, setClickedFeature] = useState<number | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);

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
      
      if (clickedFeature !== null) return;
      
      const scrollPosition = window.scrollY + window.innerHeight / 2;
      const featureElements = sectionRef.current.querySelectorAll('.hidden.lg\\:block [data-index]');
      
      let closestIndex = 0;
      let closestDistance = Infinity;
      
      featureElements.forEach((element, index) => {
        const rect = element.getBoundingClientRect();
        const elementTop = rect.top + window.scrollY;
        const distance = Math.abs(elementTop - scrollPosition);
        
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });
      
      setActiveFeature(closestIndex);
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
    
    // Mobile intersection observer (simpler, just for visibility)
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const index = parseInt(entry.target.getAttribute('data-index') || '0');
          if (entry.isIntersecting) {
            setVisibleItems(prev => new Set([...prev, index]));
            // For mobile, also set active feature
            if (window.innerWidth < 1024) {
              setActiveFeature(index);
            }
          }
        });
      },
      { threshold: 0.5 }
    );

    const mobileCards = sectionRef.current?.querySelectorAll('.lg\\:hidden [data-index]');
    mobileCards?.forEach(card => observer.observe(card));

    return () => {
      window.removeEventListener('scroll', throttledScroll);
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [clickedFeature]);

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
        
        {/* Desktop Layout */}
        <div className="hidden lg:block max-w-7xl mx-auto">
          <div className="flex gap-12">
            {/* Animations and Descriptions - Left Side */}
            <div className="flex-1">
              <div className="space-y-12">
                {features.map((feature, index) => (
                  <div
                    key={feature.title}
                    data-index={index}
                    className="space-y-6"
                  >
                    {/* Animation Area */}
                     {index === 1 ? (
                      <div className="w-full h-[400px] flex items-center justify-center">
                        <div className="w-full max-w-md h-full rounded-2xl overflow-hidden bg-surface">
                          <video 
                            autoPlay 
                            loop 
                            muted 
                            playsInline
                            preload="metadata"
                            className="w-full h-full object-cover"
                            style={{ objectPosition: 'center center' }}
                          >
                            <source src="/navi-customization-animation.webm" type="video/webm" />
                            <div className="w-full h-full flex items-center justify-center bg-muted/20 rounded-2xl border border-border/20">
                              <div className="text-center">
                                <div className="w-24 h-24 rounded-full mx-auto mb-4 flex items-center justify-center bg-primary/30">
                                  <div className="w-12 h-12 rounded-full bg-primary/60"></div>
                                </div>
                                <p className="text-muted-foreground text-sm">Customization Animation</p>
                              </div>
                            </div>
                          </video>
                        </div>
                      </div>
                    ) : index === 5 ? (
                      <div className="w-full h-[400px] flex items-center justify-center">
                        <div className="w-full max-w-md h-full rounded-2xl overflow-hidden bg-surface">
                          <video 
                            autoPlay 
                            loop 
                            muted 
                            playsInline
                            preload="metadata"
                            className="w-full h-full object-contain"
                            style={{ objectPosition: 'center center' }}
                          >
                            <source src="/navi-privacy-animation-2.webm" type="video/webm" />
                            <div className="w-full h-full flex items-center justify-center bg-muted/20 rounded-2xl border border-border/20">
                              <div className="text-center">
                                <div className="w-24 h-24 rounded-full mx-auto mb-4 flex items-center justify-center bg-primary/30">
                                  <div className="w-12 h-12 rounded-full bg-primary/60"></div>
                                </div>
                                <p className="text-muted-foreground text-sm">Privacy Animation</p>
                              </div>
                            </div>
                          </video>
                        </div>
                      </div>
                    ) : (
                      <div className={`bg-muted/20 rounded-2xl p-12 h-[400px] flex items-center justify-center border transition-all duration-300 ${
                        activeFeature === index ? 'border-primary/20 bg-primary/5' : 'border-border/20'
                      }`}>
                        <div className="text-center">
                          <div className={`w-24 h-24 rounded-full mx-auto mb-4 flex items-center justify-center transition-colors ${
                            activeFeature === index ? 'bg-primary/30' : 'bg-primary/20'
                          }`}>
                            <div className={`w-12 h-12 rounded-full transition-colors ${
                              activeFeature === index ? 'bg-primary/60' : 'bg-primary/40'
                            }`}></div>
                          </div>
                          <p className="text-muted-foreground text-sm">Animation for {feature.title}</p>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Feature Titles Menu - Right Side */}
            <div className="w-80">
              <div className="sticky top-24 space-y-2">
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
        <div className="lg:hidden space-y-8">
          {features.map((feature, index) => (
            <div 
              key={feature.title}
              data-index={index}
              className={`feature-card-no-bg reveal-up reveal-delay-${index + 1} feature-visible`}
            >
              <div className="feature-content-no-bg">
                {/* Video/Animation Area for mobile */}
                {index === 1 ? (
                  <div className="w-full h-[280px] flex items-center justify-center mb-6">
                    <div className="w-full max-w-sm h-full rounded-2xl overflow-hidden bg-surface">
                      <video 
                        autoPlay 
                        loop 
                        muted 
                        playsInline
                        preload="metadata"
                        className="w-full h-full object-cover"
                        style={{ objectPosition: 'center center' }}
                      >
                        <source src="/navi-customization-animation.webm" type="video/webm" />
                        <div className="w-full h-full flex items-center justify-center bg-muted/20 rounded-2xl border border-border/20">
                          <div className="text-center">
                            <div className="w-16 h-16 rounded-full mx-auto mb-3 flex items-center justify-center bg-primary/30">
                              <div className="w-8 h-8 rounded-full bg-primary/60"></div>
                            </div>
                            <p className="text-muted-foreground text-xs">Customization Animation</p>
                          </div>
                        </div>
                      </video>
                    </div>
                  </div>
                ) : index === 5 ? (
                  <div className="w-full h-[280px] flex items-center justify-center mb-6">
                    <div className="w-full max-w-sm h-full rounded-2xl overflow-hidden bg-surface">
                      <video 
                        autoPlay 
                        loop 
                        muted 
                        playsInline
                        preload="metadata"
                        className="w-full h-full object-contain"
                        style={{ objectPosition: 'center center' }}
                      >
                        <source src="/navi-privacy-animation-2.webm" type="video/webm" />
                        <div className="w-full h-full flex items-center justify-center bg-muted/20 rounded-2xl border border-border/20">
                          <div className="text-center">
                            <div className="w-16 h-16 rounded-full mx-auto mb-3 flex items-center justify-center bg-primary/30">
                              <div className="w-8 h-8 rounded-full bg-primary/60"></div>
                            </div>
                            <p className="text-muted-foreground text-xs">Privacy Animation</p>
                          </div>
                        </div>
                      </video>
                    </div>
                  </div>
                ) : (
                  <div className="bg-muted/20 rounded-2xl p-8 h-[200px] flex items-center justify-center border border-border/20 mb-6">
                    <div className="text-center">
                      <div className="w-16 h-16 rounded-full mx-auto mb-3 flex items-center justify-center bg-primary/30">
                        <div className="w-8 h-8 rounded-full bg-primary/60"></div>
                      </div>
                      <p className="text-muted-foreground text-xs">Animation for {feature.title}</p>
                    </div>
                  </div>
                )}

                <div className="feature-text">
                  <h3 className="text-2xl font-semibold mb-4 text-foreground">{feature.title}</h3>
                  <p className="text-muted-foreground mb-6">{feature.description}</p>
                  
                  {feature.details.length > 0 && (
                    <ul className="space-y-3">
                      {feature.details.map((detail, detailIndex) => (
                        <li key={detailIndex} className="flex items-start space-x-3 feature-detail">
                          <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC]"></div>
                          <span className="text-sm text-foreground/80 leading-relaxed">{detail}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default FeaturesSection;