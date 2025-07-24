import { Button } from "@/components/ui/button";
import FloatingParticles from "./FloatingParticles";
import ProgressiveImage from "./ProgressiveImage";
import { useState, useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";

const HeroSection = () => {
  const [typedText, setTypedText] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [arrowBottomOffset, setArrowBottomOffset] = useState("1rem");
  const baseText = "Hi! I'm Navi, your voice AI ";
  const words = ["companion.", "assistant.", "daemon."];
  
  // Handle Safari iOS video issues
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const playVideo = () => {
      if (video && video.paused) {
        // Force reload the video source to fix freezing
        const currentTime = video.currentTime;
        video.load();
        video.currentTime = currentTime;
        
        setTimeout(() => {
          video.play().catch(() => {
            // If autoplay fails, that's okay
          });
        }, 100);
      }
    };

    const pauseVideo = () => {
      if (video && !video.paused) {
        video.pause();
      }
    };

    // Handle multiple iOS Safari events
    const handleVisibilityChange = () => {
      if (document.hidden) {
        pauseVideo();
      } else {
        playVideo();
      }
    };

    const handleFocus = () => {
      playVideo();
    };

    const handleBlur = () => {
      pauseVideo();
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        // Page was restored from cache
        playVideo();
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

  useEffect(() => {
    let currentWordIndex = 0;
    let currentCharIndex = 0;
    let isDeleting = false;
    let isFirstType = true;
    let timeoutId: NodeJS.Timeout;
    
    const typeText = () => {
      const currentWord = words[currentWordIndex];
      
      if (!isDeleting) {
        // Typing
        if (currentCharIndex === 0 && isFirstType) {
          // Type the base text first
          let baseIndex = 0;
          const typeBase = () => {
            if (baseIndex <= baseText.length) {
              setTypedText(baseText.slice(0, baseIndex));
              baseIndex++;
              setTimeout(typeBase, 64);
            } else {
              isFirstType = false;
              typeText();
            }
          };
          typeBase();
          return;
        }
        
        if (currentCharIndex < currentWord.length) {
          setTypedText(baseText + currentWord.slice(0, currentCharIndex + 1));
          currentCharIndex++;
          timeoutId = setTimeout(typeText, 53);
        } else {
          // Finished typing word, wait then start deleting
          timeoutId = setTimeout(() => {
            isDeleting = true;
            typeText();
          }, 1000);
        }
      } else {
        // Deleting
        if (currentCharIndex > 0) {
          setTypedText(baseText + currentWord.slice(0, currentCharIndex - 1));
          currentCharIndex--;
          timeoutId = setTimeout(typeText, 27);
        } else {
          // Finished deleting, move to next word
          isDeleting = false;
          currentWordIndex = (currentWordIndex + 1) % words.length;
          timeoutId = setTimeout(typeText, 133);
        }
      }
    };
    
    typeText();
    
    return () => clearTimeout(timeoutId);
  }, []);

  // Handle Safari UI overlay detection and arrow positioning
  useEffect(() => {
    const updateArrowPosition = () => {
      // Check if we're on iOS Safari
      const isIOSSafari = /iPad|iPhone|iPod/.test(navigator.userAgent) && 
                         /Safari/.test(navigator.userAgent) && 
                         !/Chrome|CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
      
      if (!isIOSSafari) {
        setArrowBottomOffset("1rem");
        return;
      }

      // Use visualViewport API if available (modern Safari)
      if (window.visualViewport) {
        const viewportHeight = window.visualViewport.height;
        const windowHeight = window.innerHeight;
        const uiHeight = windowHeight - viewportHeight;
        
        // If UI is present (height difference > 20px), position above it
        if (uiHeight > 20) {
          setArrowBottomOffset(`${Math.max(uiHeight + 16, 60)}px`);
        } else {
          setArrowBottomOffset("1rem");
        }
      } else {
        // Fallback for older Safari: detect if viewport has changed significantly
        const initialHeight = window.innerHeight;
        const currentHeight = document.documentElement.clientHeight;
        const heightDiff = initialHeight - currentHeight;
        
        if (heightDiff > 20) {
          setArrowBottomOffset(`${Math.max(heightDiff + 16, 60)}px`);
        } else {
          setArrowBottomOffset("1rem");
        }
      }
    };

    // Initial positioning
    updateArrowPosition();

    // Listen for viewport changes
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateArrowPosition);
    }
    
    // Listen for orientation and resize changes
    window.addEventListener('resize', updateArrowPosition);
    window.addEventListener('orientationchange', () => {
      setTimeout(updateArrowPosition, 100);
    });

    // Listen for scroll events that might trigger Safari UI changes
    let scrollTimeout: NodeJS.Timeout;
    const handleScroll = () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(updateArrowPosition, 100);
    };
    window.addEventListener('scroll', handleScroll);

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', updateArrowPosition);
      }
      window.removeEventListener('resize', updateArrowPosition);
      window.removeEventListener('orientationchange', updateArrowPosition);
      window.removeEventListener('scroll', handleScroll);
      clearTimeout(scrollTimeout);
    };
  }, []);

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-gradient-to-br from-background via-surface to-secondary/30">
      <FloatingParticles />
      
      <div className="container mx-auto px-6 relative z-10">
                  <div className="max-w-4xl xl:max-w-6xl 2xl:max-w-7xl mx-auto text-center">
            <div className="mb-8 md:mt-3 reveal-up flex justify-center">
              <div className="w-96 h-96 md:w-120 md:h-120 rounded-full overflow-hidden bg-surface">
                <video 
                  ref={videoRef}
                  autoPlay 
                  loop 
                  muted 
                  playsInline
                  preload="metadata"
                  className="w-full h-full object-cover"
                  style={{ objectPosition: 'center center' }}
                  poster="/navi-midnight-black-hero-background-low.png"
                >
                  <source src="/navi-black-v4-hero-background.webm" type="video/webm" />
                  <ProgressiveImage
                    lowSrc="/navi-midnight-black-hero-background-low.png"
                    medSrc="/navi-midnight-black-hero-background-med.png"
                    highSrc="/navi-midnight-black-hero-background.png"
                    alt="Navi"
                    className="w-full h-full object-cover"
                    style={{ objectPosition: 'center center' }}
                  />
                </video>
              </div>
            </div>
          
          <div className="max-w-2xl mx-auto mb-12 reveal-up reveal-delay-1 flex justify-center">
            <div className="bg-gradient-to-br from-[#272725] to-[#1f1f1d] border border-border/30 rounded-full p-4 shadow-lg w-[420px]">
              <div className="flex items-center gap-3">
                <div className="flex-shrink-0 mt-1">
                  <div className="w-8 h-8 bg-white rounded-full flex items-center justify-center relative">
                    <div className="flex items-center gap-0.5">
                      <div className="w-0.5 bg-primary rounded-full animate-[voice-bar-1_1.5s_ease-in-out_infinite]"></div>
                      <div className="w-0.5 bg-primary rounded-full animate-[voice-bar-2_1.3s_ease-in-out_infinite]"></div>
                      <div className="w-0.5 bg-primary rounded-full animate-[voice-bar-3_1.7s_ease-in-out_infinite]"></div>
                      <div className="w-0.5 bg-primary rounded-full animate-[voice-bar-4_1.4s_ease-in-out_infinite]"></div>
                    </div>
                  </div>
                </div>
                <div className="flex-1 min-h-[2rem] flex items-center">
                  <p className="text-base md:text-xl text-white leading-relaxed text-left drop-shadow-sm">
                    <span className="inline">
                      {typedText}<span className="animate-pulse">|</span>
                    </span>
                  </p>
                </div>
              </div>
            </div>
          </div>
          

          
        </div>
      </div>
      
      {/* Scroll down arrow - positioned right above the fold */}
      <div className="absolute left-1/2 transform -translate-x-1/2 z-20" style={{ bottom: arrowBottomOffset }}>
        <button 
          className="p-3 rounded-full bg-gradient-to-br from-[#272725] to-[#1f1f1d] border border-border/30 hover:bg-gradient-to-br hover:from-[#323230] hover:to-[#252523] transition-all duration-300 shadow-lg animate-slow-bounce"
          onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}
        >
          <ChevronDown className="w-6 h-6 text-white" />
        </button>
      </div>
      
      {/* Gradient overlay for depth */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background/100 to-transparent"></div>
    </section>
  );
};

export default HeroSection;