import { Button } from "@/components/ui/button";
import FloatingParticles from "./FloatingParticles";

const HeroSection = () => {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-gradient-to-br from-background via-surface to-secondary/30">
      <FloatingParticles />
      
      <div className="container mx-auto px-6 relative z-10">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-6xl md:text-8xl font-light tracking-tight mb-8 reveal-up">
            <span className="gradient-text">Your Voice.</span>
            <br />
            <span className="text-foreground">Unlimited Power.</span>
          </h1>
          
          <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl mx-auto mb-12 leading-relaxed reveal-up reveal-delay-1">
            Navi transforms voice commands into infinite possibilities. 
            The first truly customizable AI hardware companion.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4 justify-center reveal-up reveal-delay-2">
            <Button 
              size="lg" 
              className="btn-luxury text-lg px-12 py-6"
              onClick={() => document.getElementById('pre-order')?.scrollIntoView({ behavior: 'smooth' })}
            >
              Pre-order Now
            </Button>
            <Button 
              variant="outline" 
              size="lg" 
              className="btn-pearl text-lg px-12 py-6"
              onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}
            >
              Explore Features
            </Button>
          </div>
          
          <div className="mt-16 reveal-up reveal-delay-3">
            <p className="text-sm text-muted-foreground mb-4">Available in two finishes</p>
            <div className="flex justify-center space-x-4">
              <div className="w-3 h-3 bg-primary rounded-full shadow-lg"></div>
              <div className="w-3 h-3 bg-surface-elevated border border-border rounded-full shadow-lg"></div>
            </div>
          </div>
        </div>
      </div>
      
      {/* Gradient overlay for depth */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background/100 to-transparent"></div>
    </section>
  );
};

export default HeroSection;