import { Card, CardContent } from "@/components/ui/card";
import { Palette, Zap, Shield, Bolt } from "lucide-react";

const FeaturesSection = () => {
  const features = [
    {
      icon: Palette,
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
      icon: Zap,
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
      icon: Shield,
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
      icon: Bolt,
      title: "Lightning Fast",
      description: "Instant responses without interruption",
      details: [
        "800ms response time",
        "Interruptible",
        "Doesn't Interrupt you"
      ]
    }
  ];

  return (
    <section id="features" className="py-24 bg-surface relative">
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
            <Card 
              key={feature.title}
              className={`group bg-card border-border/50 hover:border-border transition-all duration-500 hover:shadow-[var(--shadow-elegant)] hover:scale-105 reveal-up reveal-delay-${index + 1}`}
            >
              <CardContent className="p-8">
                <div className="mb-6">
                  <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
                    <feature.icon className="w-8 h-8 text-primary" />
                  </div>
                  <h3 className="text-2xl font-semibold mb-2">{feature.title}</h3>
                  <p className="text-muted-foreground">{feature.description}</p>
                </div>
                
                <ul className="space-y-3">
                  {feature.details.map((detail, detailIndex) => (
                    <li key={detailIndex} className="flex items-start space-x-3">
                      <div className="w-1.5 h-1.5 bg-primary rounded-full mt-2 flex-shrink-0"></div>
                      <span className="text-sm text-foreground/80 leading-relaxed">{detail}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
};

export default FeaturesSection;