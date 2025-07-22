import { useEffect, useRef, useState } from "react";

const FeaturesSection = () => {
  const [activeFeature, setActiveFeature] = useState(0);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const sectionRef = useRef<HTMLDivElement>(null);
  const featureRefs = useRef<(HTMLDivElement | null)[]>([]);

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
        "As AI gets better, the level of abstraction of problems that can be solved increases"
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
    // Initialize refs array
    featureRefs.current = featureRefs.current.slice(0, features.length);
  }, [features.length]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const index = parseInt(entry.target.getAttribute('data-index') || '0');
          if (entry.isIntersecting) {
            setVisibleItems(prev => new Set([...prev, index]));
            setActiveFeature(index);
          }
        });
      },
      { threshold: 0.6, rootMargin: '-20% 0px' }
    );

    // Observe mobile feature cards and desktop scroll triggers
    const mobileCards = sectionRef.current?.querySelectorAll('.lg\\:hidden [data-index]');
    const desktopTriggers = sectionRef.current?.querySelectorAll('.hidden.lg\\:block [data-index]');
    
    mobileCards?.forEach(card => observer.observe(card));
    desktopTriggers?.forEach(trigger => observer.observe(trigger));

    return () => observer.disconnect();
  }, []);

  const handleFeatureClick = (index: number) => {
    setActiveFeature(index);
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
            {/* Main Content Area - Left Side */}
            <div className="flex-1">
              <div className="sticky top-24 min-h-[600px] flex flex-col justify-center">
                {/* Animation Placeholder */}
                <div className="bg-muted/20 rounded-2xl p-12 mb-8 min-h-[400px] flex items-center justify-center border border-border/20">
                  <div className="text-center">
                    <div className="w-24 h-24 bg-primary/20 rounded-full mx-auto mb-4 flex items-center justify-center">
                      <div className="w-12 h-12 bg-primary/40 rounded-full"></div>
                    </div>
                    <p className="text-muted-foreground text-sm">Animation for {features[activeFeature].title}</p>
                  </div>
                </div>
                
                {/* Description and Details */}
                <div className="space-y-6">
                  <div>
                    <h3 className="text-3xl font-semibold mb-4 text-foreground">{features[activeFeature].title}</h3>
                    <p className="text-lg text-muted-foreground mb-6">{features[activeFeature].description}</p>
                  </div>
                  
                  {features[activeFeature].details.length > 0 && (
                    <ul className="space-y-4">
                      {features[activeFeature].details.map((detail, detailIndex) => (
                        <li key={detailIndex} className="flex items-start space-x-3">
                          <div className="w-2 h-2 bg-primary rounded-full mt-2 flex-shrink-0"></div>
                          <span className="text-foreground/80 leading-relaxed">{detail}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>

            {/* Sticky Navigation - Right Side */}
            <div className="w-80">
              <div className="sticky top-24 space-y-2">
                {features.map((feature, index) => (
                  <button
                    key={feature.title}
                    onClick={() => handleFeatureClick(index)}
                    className={`w-full text-left p-4 rounded-lg transition-all duration-300 ${
                      activeFeature === index
                        ? 'bg-primary/10 border-l-4 border-primary text-foreground'
                        : 'hover:bg-muted/50 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <h4 className="font-medium text-sm leading-tight">{feature.title}</h4>
                  </button>
                ))}
              </div>
            </div>
          </div>
          
          {/* Invisible scroll triggers for desktop */}
          <div className="relative">
            {features.map((_, index) => (
              <div
                key={`trigger-${index}`}
                data-index={index}
                className="h-96 w-1 opacity-0 pointer-events-none"
                style={{ marginTop: index === 0 ? '200px' : '0' }}
              />
            ))}
          </div>
        </div>

        {/* Mobile Layout */}
        <div className="lg:hidden space-y-8">
          {features.map((feature, index) => (
            <div 
              key={feature.title}
              data-index={index}
              className={`feature-card-no-bg reveal-up reveal-delay-${index + 1} ${
                visibleItems.has(index) ? 'feature-visible' : ''
              }`}
            >
              <div className="feature-content-no-bg">
                <div className="feature-text">
                  <h3 className="text-2xl font-semibold mb-4 text-foreground">{feature.title}</h3>
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