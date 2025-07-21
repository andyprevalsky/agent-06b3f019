import { useEffect, useRef, useState } from "react";

const FeaturesSection = () => {
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
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
        "As AI gets better, the level of abstraction of problems that can be solved increases"
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
      case 0: // Frontier AI - Pulsing core
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
      case 1: // Fully Customizable - Rotating gears
        return (
          <div className="feature-animation-container">
            <div className={`morphing-shapes ${isVisible ? 'animate' : ''}`}>
              <div className="shape shape-1"></div>
              <div className="shape shape-2"></div>
              <div className="shape shape-3"></div>
            </div>
          </div>
        );
      case 2: // Seamless Conversations - Wave forms
        return (
          <div className="feature-animation-container">
            <div className={`lightning-container ${isVisible ? 'animate' : ''}`}>
              <div className="lightning-bolt"></div>
              <div className="lightning-glow"></div>
            </div>
          </div>
        );
      case 3: // Spawn Agents - Network nodes
        return (
          <div className="feature-animation-container">
            <div className={`lightning-container ${isVisible ? 'animate' : ''}`}>
              <div className="lightning-bolt"></div>
              <div className="lightning-glow"></div>
            </div>
          </div>
        );
      case 4: // Privacy First - Shield animation
        return (
          <div className="feature-animation-container">
            <div className={`shield-container ${isVisible ? 'animate' : ''}`}>
              <div className="shield-base"></div>
              <div className="shield-lock"></div>
              <div className="shield-rings"></div>
            </div>
          </div>
        );
      case 5: // Navi Grows - Growing brain network
        return (
          <div className="feature-animation-container">
            <div className={`morphing-shapes ${isVisible ? 'animate' : ''}`}>
              <div className="shape shape-1"></div>
              <div className="shape shape-2"></div>
              <div className="shape shape-3"></div>
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
                <div className="feature-animation-wrapper">
                  {getAnimationComponent(index, visibleItems.has(index))}
                </div>
                
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