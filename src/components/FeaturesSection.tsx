import { useEffect, useRef, useState } from "react";

const FeaturesSection = () => {
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const sectionRef = useRef<HTMLDivElement>(null);

  const features = [
    {
      title: "Pick Any Provider",
      description: "Choose from leading AI providers",
      details: []
    },
    {
      title: "Fully Customizable",
      description: "Tailor every aspect to your needs",
      details: [
        "Use any voice of your choice",
        "Change your system prompt dynamically",
        "Pick personalities from Marketplace (Jarvis, and countless others)",
        "Configure response styles and behaviors"
      ]
    },
    {
      title: "Tool Call Enabled",
      description: "Voice commands that trigger real actions",
      details: [
        "Trigger any arbitrary code through voice commands",
        "Access comprehensive tool marketplace",
        "Write your own custom tools in just 5 minutes",
        "Seamless integration with your existing workflows"
      ]
    },
    {
      title: "Privacy First",
      description: "Your data stays yours, always",
      details: [
        "We never store any data about you",
        "Direct communication from hardware to AI providers",
        "End-to-end encryption for all voice data",
        "Complete transparency in data handling"
      ]
    },
    {
      title: "Lightning Fast",
      description: "Instant responses without interruption",
      details: [
        "800ms response time",
        "Interruptible",
        "Doesn't Interrupt you"
      ]
    }
  ];

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const index = parseInt(entry.target.getAttribute('data-index') || '0');
          if (entry.isIntersecting) {
            setVisibleItems(prev => new Set([...prev, index]));
          }
        });
      },
      { threshold: 0.3, rootMargin: '-50px' }
    );

    const cards = sectionRef.current?.querySelectorAll('[data-index]');
    cards?.forEach(card => observer.observe(card));

    return () => observer.disconnect();
  }, []);

  const getAnimationComponent = (index: number, isVisible: boolean) => {
    switch (index) {
      case 0: // Pick Any Provider - No animation here, full-width ticker below
        return null;
      case 1: // Fully Customizable - Morphing shapes
        return (
          <div className="feature-animation-container">
            <div className={`morphing-shapes ${isVisible ? 'animate' : ''}`}>
              <div className="shape shape-1"></div>
              <div className="shape shape-2"></div>
              <div className="shape shape-3"></div>
            </div>
          </div>
        );
      case 2: // Tool Call Enabled - Lightning effects
        return (
          <div className="feature-animation-container">
            <div className={`lightning-container ${isVisible ? 'animate' : ''}`}>
              <div className="lightning-bolt"></div>
              <div className="lightning-glow"></div>
            </div>
          </div>
        );
      case 3: // Privacy First - Shield animation
        return (
          <div className="feature-animation-container">
            <div className={`shield-container ${isVisible ? 'animate' : ''}`}>
              <div className="shield-base"></div>
              <div className="shield-lock"></div>
              <div className="shield-rings"></div>
            </div>
          </div>
        );
      case 4: // Lightning Fast - Pulse/speed
        return (
          <div className="feature-animation-container">
            <div className={`speed-container ${isVisible ? 'animate' : ''}`}>
              <div className="speed-core"></div>
              <div className="speed-ring-1"></div>
              <div className="speed-ring-2"></div>
              <div className="speed-particles"></div>
            </div>
          </div>
        );
      default:
        return null;
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
        
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-5 gap-8 max-w-8xl mx-auto">
          {features.map((feature, index) => (
            <div 
              key={feature.title}
              data-index={index}
              className={`feature-card-no-bg reveal-up reveal-delay-${index + 1} ${
                visibleItems.has(index) ? 'feature-visible' : ''
              }`}
            >
              <div className="feature-content-no-bg">
                {index !== 0 && (
                  <div className="feature-animation-wrapper">
                    {getAnimationComponent(index, visibleItems.has(index))}
                  </div>
                )}
                
                <div className="feature-text">
                  <h3 className="text-2xl font-semibold mb-2 text-foreground">{feature.title}</h3>
                  <p className="text-muted-foreground mb-6">{feature.description}</p>
                  
                  {feature.details.length > 0 && (
                    <ul className="space-y-3">
                      {feature.details.map((detail, detailIndex) => (
                        <li key={detailIndex} className="flex items-start space-x-3 feature-detail">
                          <div className="w-1.5 h-1.5 bg-primary rounded-full mt-2 flex-shrink-0"></div>
                          <span className="text-sm text-foreground/80 leading-relaxed">{detail}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  
                  {/* Show ticker only for "Pick Any Provider" feature */}
                  {index === 0 && (
                    <div className="mt-8 w-full overflow-hidden">
                      <div className="logo-ticker animate">
                        <div className="ticker-track">
                          <img src="/lovable-uploads/62a020ea-47e5-4023-ad55-7b6466acd665.png" alt="OpenAI" className="provider-logo" />
                          <img src="/lovable-uploads/08d900d5-b4c6-43d7-8e90-87a13069cd14.png" alt="Anthropic" className="provider-logo" />
                          <img src="/lovable-uploads/744124eb-2645-458e-8b89-dd1336ffb39c.png" alt="Cerebras" className="provider-logo" />
                          <img src="/lovable-uploads/5cfb69dd-e48d-49bf-b9f9-2769e53b023f.png" alt="ElevenLabs" className="provider-logo elevenlabs-logo" />
                          <img src="/lovable-uploads/91e751a7-115a-416b-b7b3-9e7cee11584b.png" alt="Google AI" className="provider-logo" />
                          <img src="/lovable-uploads/1a447f91-b21f-4746-9f75-278db25daedd.png" alt="Meta" className="provider-logo" />
                          <img src="/lovable-uploads/62a020ea-47e5-4023-ad55-7b6466acd665.png" alt="OpenAI" className="provider-logo" />
                          <img src="/lovable-uploads/08d900d5-b4c6-43d7-8e90-87a13069cd14.png" alt="Anthropic" className="provider-logo" />
                          <img src="/lovable-uploads/744124eb-2645-458e-8b89-dd1336ffb39c.png" alt="Cerebras" className="provider-logo" />
                          <img src="/lovable-uploads/5cfb69dd-e48d-49bf-b9f9-2769e53b023f.png" alt="ElevenLabs" className="provider-logo elevenlabs-logo" />
                          <img src="/lovable-uploads/91e751a7-115a-416b-b7b3-9e7cee11584b.png" alt="Google AI" className="provider-logo" />
                          <img src="/lovable-uploads/1a447f91-b21f-4746-9f75-278db25daedd.png" alt="Meta" className="provider-logo" />
                        </div>
                      </div>
                    </div>
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