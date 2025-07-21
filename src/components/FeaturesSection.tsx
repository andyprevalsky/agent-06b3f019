import { useEffect, useRef, useState } from "react";

const FeaturesSection = () => {
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const sectionRef = useRef<HTMLDivElement>(null);

  const features = [
    {
      title: "Fully Customizable",
      description: "Tailor every aspect to your needs",
      details: [
        "Use any voice of your choice",
        "Any LLM Provider - OpenAI, Anthropic, Cerebrus, and more",
        "Change your system prompt dynamically",
        "Pick personalities from Marketplace (Jarvis, and countless others)"
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
      case 0: // Fully Customizable - Morphing shapes
        return (
          <div className="feature-animation-container">
            <div className={`morphing-shapes ${isVisible ? 'animate' : ''}`}>
              <div className="shape shape-1"></div>
              <div className="shape shape-2"></div>
              <div className="shape shape-3"></div>
            </div>
          </div>
        );
      case 1: // Tool Call Enabled - Lightning effects
        return (
          <div className="feature-animation-container">
            <div className={`lightning-container ${isVisible ? 'animate' : ''}`}>
              <div className="lightning-bolt"></div>
              <div className="lightning-glow"></div>
            </div>
          </div>
        );
      case 2: // Privacy First - Shield animation
        return (
          <div className="feature-animation-container">
            <div className={`shield-container ${isVisible ? 'animate' : ''}`}>
              <div className="shield-base"></div>
              <div className="shield-lock"></div>
              <div className="shield-rings"></div>
            </div>
          </div>
        );
      case 3: // Lightning Fast - Pulse/speed
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
        
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-8 max-w-7xl mx-auto">
          {features.map((feature, index) => (
            <div 
              key={feature.title}
              data-index={index}
              className={`feature-card reveal-up reveal-delay-${index + 1} ${
                visibleItems.has(index) ? 'feature-visible' : ''
              }`}
            >
              <div className="feature-content">
                <div className="feature-animation-wrapper">
                  {getAnimationComponent(index, visibleItems.has(index))}
                </div>
                
                <div className="feature-text">
                  <h3 className="text-2xl font-semibold mb-2">{feature.title}</h3>
                  <p className="text-muted-foreground mb-6">{feature.description}</p>
                  
                  <ul className="space-y-3">
                    {feature.details.map((detail, detailIndex) => (
                      <li key={detailIndex} className="flex items-start space-x-3 feature-detail">
                        <div className="w-1.5 h-1.5 bg-primary rounded-full mt-2 flex-shrink-0"></div>
                        <span className="text-sm text-foreground/80 leading-relaxed">{detail}</span>
                      </li>
                    ))}
                  </ul>
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