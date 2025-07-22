
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HelpCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const PreOrderSection = () => {
  const blackVideoRef = useRef<HTMLVideoElement>(null);
  const whiteVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const syncVideos = async () => {
      if (blackVideoRef.current && whiteVideoRef.current) {
        try {
          // Ensure both videos are ready
          await Promise.all([
            blackVideoRef.current.load(),
            whiteVideoRef.current.load()
          ]);
          
          // Start both videos at the same time
          await Promise.all([
            blackVideoRef.current.play(),
            whiteVideoRef.current.play()
          ]);
        } catch (error) {
          console.log('Video sync failed:', error);
        }
      }
    };

    syncVideos();
  }, []);

  const handlePreOrder = (variant: 'black' | 'white') => {
    // Real Stripe Payment Links - create these in your Stripe dashboard
    const checkoutUrls = {
      black: 'https://buy.stripe.com/5kQ5kD6Dy4vr2Zr1OB5kk03', // Midnight Black payment link
      white: 'https://buy.stripe.com/8x2dR9aTO6Dz6bD0Kx5kk02'  // Pearl White payment link
    };

    // Simulate creating a checkout session and redirect
    console.log(`Creating checkout session for ${variant} Navi - $${variant === 'black' ? '299' : '199'}`);
    
    // Open mock Stripe checkout in new tab
    window.open(checkoutUrls[variant], '_blank');
  };


  return (
    <section id="pre-order" className="py-32 bg-gradient-to-b from-surface to-background relative overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <Badge variant="outline" className="mb-4 px-4 py-2 text-sm border-primary/20 text-primary">
            Limited Early Access
          </Badge>
          <h2 className="text-5xl font-light tracking-tight mb-6 reveal-up">
            <span className="gradient-text">Reserve Your Navi</span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto reveal-up reveal-delay-1">
            Be among the first to experience the future of voice AI. 
            Choose your preferred finish and secure your place in line.
          </p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          
          {/* Midnight Black */}
          <Card className="group bg-card border-border/50 hover:border-primary/30 transition-all duration-500 hover:shadow-[var(--shadow-luxury)] hover:scale-105 reveal-up reveal-delay-1">
            <CardContent className="p-8 text-center">
              <div className="mb-6">
                <div className="w-48 h-48 rounded-3xl mx-auto mb-4 overflow-hidden">
                  <video 
                    ref={blackVideoRef}
                    className="w-full h-full object-cover"
                    loop
                    muted
                    playsInline
                    preload="metadata"
                  >
                    <source src="/navi-black-demo.webm" type="video/webm" />
                    <img src="/navi-black.png" alt="Navi Black" className="w-full h-full object-cover" />
                  </video>
                </div>
                <h3 className="text-2xl font-semibold mb-2">Midnight Black</h3>
                <p className="text-muted-foreground">Deep, sophisticated finish with precision-crafted aluminum</p>
              </div>
              
              <div className="mb-8">
                <div className="text-3xl font-light tracking-tight">
                  $299 + 
                  <Popover>
                    <PopoverTrigger asChild>
                      <span className="text-sm text-primary hover:underline cursor-pointer ml-1 inline-flex items-center gap-1">
                        service fee
                        <HelpCircle size={12} />
                      </span>
                    </PopoverTrigger>
                    <PopoverContent className="max-w-xs bg-background border shadow-md">
                      <div className="text-sm">
                        <p className="font-medium mb-2">AI Provider Services</p>
                        <p className="mb-2">All Navi devices require AI provider services. You have two options:</p>
                        <div className="space-y-2">
                          <div>
                            <p className="font-medium">Provide Your Own API Keys</p>
                            <p className="text-xs opacity-80">Use your existing OpenAI, Anthropic, or other provider accounts</p>
                          </div>
                          <div>
                            <p className="font-medium">Pay-as-You-Go Service</p>
                            <p className="text-xs opacity-80">We handle everything at cost with no markup</p>
                          </div>
                        </div>
                        <p className="text-xs opacity-60 mt-2">Service charges cover AI provider costs only. We don't profit from this component.</p>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
              
              <Button 
                onClick={() => handlePreOrder('black')}
                className="btn-luxury w-full"
                size="lg"
              >
                Pre-order
              </Button>
              
              <p className="text-xs text-muted-foreground mt-4">
                Free shipping • 30-day returns • 2-year warranty
              </p>
            </CardContent>
          </Card>
          
          {/* Pearl White */}
          <Card className="group bg-surface-elevated border-border/50 hover:border-space-gray/30 transition-all duration-500 hover:shadow-[var(--shadow-luxury)] hover:scale-105 reveal-up reveal-delay-2">
            <CardContent className="p-8 text-center">
              <div className="mb-6">
                <div className="w-48 h-48 rounded-3xl mx-auto mb-4 overflow-hidden">
                  <video 
                    ref={whiteVideoRef}
                    className="w-full h-full object-cover"
                    loop
                    muted
                    playsInline
                    preload="metadata"
                  >
                    <source src="/navi-white-demo.webm" type="video/webm" />
                    <img src="/navi-white.png" alt="Navi White" className="w-full h-full object-cover" />
                  </video>
                </div>
                <h3 className="text-2xl font-semibold mb-2">Pearl White</h3>
                <p className="text-muted-foreground">Lustrous ceramic-like finish that captures and reflects light</p>
              </div>
              
              <div className="mb-8">
                <div className="text-3xl font-light tracking-tight">
                  $199 + 
                  <Popover>
                    <PopoverTrigger asChild>
                      <span className="text-sm text-primary hover:underline cursor-pointer ml-1 inline-flex items-center gap-1">
                        service fee
                        <HelpCircle size={12} />
                      </span>
                    </PopoverTrigger>
                    <PopoverContent className="max-w-xs bg-background border shadow-md">
                      <div className="text-sm">
                        <p className="font-medium mb-2">AI Provider Services</p>
                        <p className="mb-2">All Navi devices require AI provider services. You have two options:</p>
                        <div className="space-y-2">
                          <div>
                            <p className="font-medium">Provide Your Own API Keys</p>
                            <p className="text-xs opacity-80">Use your existing OpenAI, Anthropic, or other provider accounts</p>
                          </div>
                          <div>
                            <p className="font-medium">Pay-as-You-Go Service</p>
                            <p className="text-xs opacity-80">We handle everything at cost with no markup</p>
                          </div>
                        </div>
                        <p className="text-xs opacity-60 mt-2">Service charges cover AI provider costs only. We don't profit from this component.</p>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
              
              <Button 
                onClick={() => handlePreOrder('white')}
                className="btn-pearl w-full"
                size="lg"
              >
                Pre-order
              </Button>
              
              <p className="text-xs text-muted-foreground mt-4">
                Free shipping • 30-day returns • 2-year warranty
              </p>
            </CardContent>
          </Card>
          
        </div>
        
        <div className="text-center mt-12 reveal-up reveal-delay-3">
          <p className="text-sm text-muted-foreground mb-4">
            Expected delivery: Q2 2024 • Limited quantities available
          </p>
          <div className="flex justify-center space-x-8">
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-green-500 rounded-full"></div>
              <span className="text-xs text-muted-foreground">Secure payment</span>
            </div>
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-green-500 rounded-full"></div>
              <span className="text-xs text-muted-foreground">No upfront charges</span>
            </div>
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-green-500 rounded-full"></div>
              <span className="text-xs text-muted-foreground">Cancel anytime</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default PreOrderSection;
