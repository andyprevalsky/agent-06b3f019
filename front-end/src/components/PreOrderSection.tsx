
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { HelpCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInView } from "react-intersection-observer";

const PreOrderSection = () => {
  const blackVideoRef = useRef<HTMLVideoElement>(null);
  const whiteVideoRef = useRef<HTMLVideoElement>(null);
  const [isSafari, setIsSafari] = useState(false);
  const [blackPopoverOpen, setBlackPopoverOpen] = useState(false);
  const [whitePopoverOpen, setWhitePopoverOpen] = useState(false);
  const { ref: blackInViewRef, inView: blackInView } = useInView({ rootMargin: "600px", triggerOnce: true });
  const { ref: whiteInViewRef, inView: whiteInView } = useInView({ rootMargin: "600px", triggerOnce: true });
  const { ref: blackVisibleRef, inView: blackVisible } = useInView({ rootMargin: "100px", threshold: 0.15 });
  const { ref: whiteVisibleRef, inView: whiteVisible } = useInView({ rootMargin: "100px", threshold: 0.15 });

  const setBlackWrapperRef = (node: HTMLDivElement | null) => {
    blackInViewRef(node);
    blackVisibleRef(node);
  };
  const setWhiteWrapperRef = (node: HTMLDivElement | null) => {
    whiteInViewRef(node);
    whiteVisibleRef(node);
  };

  useEffect(() => {
    // Detect Safari browser
    const detectSafari = () => {
      const userAgent = navigator.userAgent.toLowerCase();
      return userAgent.includes('safari') && !userAgent.includes('chrome') && !userAgent.includes('firefox');
    };
    
    setIsSafari(detectSafari());
  }, []);

  useEffect(() => {
    const syncVideos = async () => {
      // Only sync videos if not Safari (Safari users get static images)
      if (!isSafari && blackVideoRef.current && whiteVideoRef.current && blackInView && whiteInView) {
        try {
          const blackVideo = blackVideoRef.current;
          const whiteVideo = whiteVideoRef.current;
          
          // Reset both videos to start
          blackVideo.currentTime = 0;
          whiteVideo.currentTime = 0;
          
          // Ensure both videos are loaded
          await Promise.all([
            new Promise((resolve) => {
              if (blackVideo.readyState >= 3) resolve(null);
              else blackVideo.addEventListener('canplay', () => resolve(null), { once: true });
            }),
            new Promise((resolve) => {
              if (whiteVideo.readyState >= 3) resolve(null);
              else whiteVideo.addEventListener('canplay', () => resolve(null), { once: true });
            })
          ]);
          
          // Pause both first to ensure clean start
          blackVideo.pause();
          whiteVideo.pause();
          
          // Reset time again and play simultaneously
          blackVideo.currentTime = 0;
          whiteVideo.currentTime = 0;
          
          await Promise.all([
            blackVideo.play(),
            whiteVideo.play()
          ]);
        } catch (error) {
          console.log('Video sync failed:', error);
        }
      }
    };

    syncVideos();
  }, [isSafari, blackInView, whiteInView]);

  // Pause/play based on actual viewport visibility (no stutter)
  useEffect(() => {
    const video = blackVideoRef.current;
    if (!video) return;
    if (blackVisible) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [blackVisible]);

  useEffect(() => {
    const video = whiteVideoRef.current;
    if (!video) return;
    if (whiteVisible) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [whiteVisible]);

  // Handle Safari iOS video issues for both videos
  useEffect(() => {
    const blackVideo = blackVideoRef.current;
    const whiteVideo = whiteVideoRef.current;
    
    if (!blackVideo || !whiteVideo) return;

    const playVideos = () => {
      if (blackVideo && blackVideo.paused) {
        // Force reload the video source to fix freezing
        const currentTime = blackVideo.currentTime;
        blackVideo.load();
        blackVideo.currentTime = currentTime;
        
        setTimeout(() => {
          blackVideo.play().catch(() => {
            // If autoplay fails, that's okay
          });
        }, 100);
      }
      
      if (whiteVideo && whiteVideo.paused) {
        // Force reload the video source to fix freezing
        const currentTime = whiteVideo.currentTime;
        whiteVideo.load();
        whiteVideo.currentTime = currentTime;
        
        setTimeout(() => {
          whiteVideo.play().catch(() => {
            // If autoplay fails, that's okay
          });
        }, 100);
      }
    };

    const pauseVideos = () => {
      if (blackVideo && !blackVideo.paused) {
        blackVideo.pause();
      }
      if (whiteVideo && !whiteVideo.paused) {
        whiteVideo.pause();
      }
    };

    // Handle multiple iOS Safari events
    const handleVisibilityChange = () => {
      if (document.hidden) {
        pauseVideos();
      } else {
        playVideos();
      }
    };

    const handleFocus = () => {
      playVideos();
    };

    const handleBlur = () => {
      pauseVideos();
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        // Page was restored from cache
        playVideos();
      }
    };

    // Add all the event listeners for comprehensive iOS Safari support
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('pageshow', handlePageShow);
    };
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
    <section id="pre-order" className="relative z-20 py-32 bg-gradient-to-b from-surface to-background overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-5xl font-light tracking-tight mb-6 reveal-up">
            <span className="gradient-text">Pre-order</span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto reveal-up reveal-delay-1">
            You've been given early access to acquire one of the first 10 Navis. 
            Choose your preferred finish and lock in your spot before the public release.
          </p>
          
          <div className="text-center mt-8 mb-8 reveal-up reveal-delay-2">
            <p className="text-sm text-muted-foreground mb-3">Available in 2 colors</p>
            <div className="flex justify-center space-x-6">
              <div className="group relative flex flex-col items-center">
                <div 
                  className="w-3 h-3 rounded-full transition-transform duration-200 hover:scale-140 cursor-pointer" 
                  style={{ backgroundColor: '#010203' }}
                  title="Midnight Black"
                ></div>
                <span className="absolute top-6 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap">
                  Midnight Black
                </span>
              </div>
              <div className="group relative flex flex-col items-center">
                <div 
                  className="w-3 h-3 rounded-full border border-gray-300 transition-transform duration-200 hover:scale-140 cursor-pointer" 
                  style={{ backgroundColor: '#F0F0FF' }}
                  title="Pearl White"
                ></div>
                <span className="absolute top-6 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-300 whitespace-nowrap">
                  Pearl White
                </span>
              </div>
            </div>
          </div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          {/* Midnight Black - wrap card and button together, like WaitlistSection */}
          <div className="w-full">
            <Card className="group bg-card border-border/50 hover:border-primary/30 transition-all duration-500 hover:shadow-[var(--shadow-luxury)] hover:scale-105 reveal-up reveal-delay-1">
              <CardContent className="p-8 text-center">
                 <div className="mb-6">
                  <div ref={setBlackWrapperRef} className="w-72 h-72 rounded-3xl mx-auto mb-4 overflow-hidden bg-surface">
                    <video 
                      ref={blackVideoRef}
                      autoPlay
                      className="w-full h-full object-cover"
                      loop
                      muted
                      playsInline
                      preload={blackInView ? "auto" : "none"}
                      poster="/navi-midnight-black-white-background.png"
                    >
                      {blackInView && (
                        <source src="/navi-black-v4-white-background.webm" type="video/webm" />
                      )}
                      <img src="/navi-midnight-black-white-background.png" alt="Navi Black" className="w-full h-full object-cover" />
                    </video>
                  </div>
                  <h3 className="text-2xl font-semibold mb-2">Midnight Black</h3>
                  <p className="text-muted-foreground">Deep, sophisticated finish with precision-crafted aluminum</p>
                </div>
                
                <div className="mb-8">
                  <div className="text-3xl font-light tracking-tight">
                    $199 +
                    <Popover open={blackPopoverOpen} onOpenChange={setBlackPopoverOpen}>
                      <PopoverTrigger asChild>
                        <span 
                          className="text-sm text-primary hover:underline cursor-pointer ml-1 inline-flex items-center gap-1"
                          onMouseEnter={() => setBlackPopoverOpen(true)}
                          onMouseLeave={() => setBlackPopoverOpen(false)}
                        >
                          service fee
                          <HelpCircle size={12} />
                        </span>
                      </PopoverTrigger>
                      <PopoverContent 
                        className="max-w-xs bg-background border shadow-md"
                        onMouseEnter={() => setBlackPopoverOpen(true)}
                        onMouseLeave={() => setBlackPopoverOpen(false)}
                      >
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
              </CardContent>
            </Card>
            {/* Button below the card (Midnight Black), within same grid item */}
            <div className="mt-6">
              <Button 
                onClick={() => handlePreOrder('black')}
                className="btn-luxury w-full"
                size="lg"
              >
                Pre-order
              </Button>
              <p className="text-xs text-muted-foreground mt-4 text-center">
                Free shipping • 30-day returns
              </p>
            </div>
          </div>

          {/* Pearl White - wrap card and button together, like WaitlistSection */}
          <div className="w-full">
            <Card className="group bg-surface-elevated border-border/50 hover:border-space-gray/30 transition-all duration-500 hover:shadow-[var(--shadow-luxury)] hover:scale-105 reveal-up reveal-delay-2">
              <CardContent className="p-8 text-center">
                 <div className="mb-6">
                  <div ref={setWhiteWrapperRef} className="w-72 h-72 rounded-3xl mx-auto mb-4 overflow-hidden bg-surface">
                    <video 
                      ref={whiteVideoRef}
                      autoPlay
                      className="w-full h-full object-cover"
                      loop
                      muted
                      playsInline
                      preload={whiteInView ? "auto" : "none"}
                      poster="/navi-pearl-white-white-background.png"
                    >
                      {whiteInView && (
                        <source src="/navi-white-v4-white-background.webm" type="video/webm" />
                      )}
                      <img src="/navi-pearl-white-white-background.png" alt="Navi White" className="w-full h-full object-cover" />
                    </video>
                  </div>
                  <h3 className="text-2xl font-semibold mb-2">Pearl White</h3>
                  <p className="text-muted-foreground">Lustrous ceramic-like finish that captures and reflects light</p>
                </div>
                
                <div className="mb-8">
                  <div className="text-3xl font-light tracking-tight">
                    $199 + 
                    <Popover open={whitePopoverOpen} onOpenChange={setWhitePopoverOpen}>
                      <PopoverTrigger asChild>
                        <span 
                          className="text-sm text-primary hover:underline cursor-pointer ml-1 inline-flex items-center gap-1"
                          onMouseEnter={() => setWhitePopoverOpen(true)}
                          onMouseLeave={() => setWhitePopoverOpen(false)}
                        >
                          service fee
                          <HelpCircle size={12} />
                        </span>
                      </PopoverTrigger>
                      <PopoverContent 
                        className="max-w-xs bg-background border shadow-md"
                        onMouseEnter={() => setWhitePopoverOpen(true)}
                        onMouseLeave={() => setWhitePopoverOpen(false)}
                      >
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
              </CardContent>
            </Card>
            {/* Button below the card (Pearl White), within same grid item */}
            <div className="mt-6">
              <Button 
                onClick={() => handlePreOrder('white')}
                className="btn-pearl w-full"
                size="lg"
              >
                Pre-order
              </Button>
              <p className="text-xs text-muted-foreground mt-4 text-center">
                Free shipping • 30-day returns
              </p>
            </div>
          </div>
        </div>
        
        <div className="text-center mt-12 reveal-up reveal-delay-3">
          <p className="text-sm text-muted-foreground mb-4">
            Expected delivery: Q3 2025 • Limited quantities available
          </p>
        </div>
      </div>
    </section>
  );
};

export default PreOrderSection;
