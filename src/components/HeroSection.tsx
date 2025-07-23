import { Button } from "@/components/ui/button";
import FloatingParticles from "./FloatingParticles";
import ProgressiveImage from "./ProgressiveImage";
import { useState, useEffect, useRef } from "react";
import { MessageCircle } from "lucide-react";

const HeroSection = () => {
  const [typedText, setTypedText] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const baseText = "Hi! I'm Navi, your voice AI ";
  const words = ["companion.", "assistant.", "daemon."];
  
  // Handle Safari iOS video issues
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Handle page visibility changes for Safari iOS
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Page is hidden, pause video
        if (video && !video.paused) {
          video.pause();
        }
      } else {
        // Page is visible again, try to play video
        if (video && video.paused) {
          // Small delay to ensure page is fully visible
          setTimeout(() => {
            video.play().catch(() => {
              // If autoplay fails, that's okay
            });
          }, 100);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
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
              setTimeout(typeBase, 96);
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
          timeoutId = setTimeout(typeText, 80);
        } else {
          // Finished typing word, wait then start deleting
          timeoutId = setTimeout(() => {
            isDeleting = true;
            typeText();
          }, 1500);
        }
      } else {
        // Deleting
        if (currentCharIndex > 0) {
          setTypedText(baseText + currentWord.slice(0, currentCharIndex - 1));
          currentCharIndex--;
          timeoutId = setTimeout(typeText, 40);
        } else {
          // Finished deleting, move to next word
          isDeleting = false;
          currentWordIndex = (currentWordIndex + 1) % words.length;
          timeoutId = setTimeout(typeText, 200);
        }
      }
    };
    
    typeText();
    
    return () => clearTimeout(timeoutId);
  }, []);

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-gradient-to-br from-background via-surface to-secondary/30">
      <FloatingParticles />
      
      <div className="container mx-auto px-6 relative z-10">
                  <div className="max-w-4xl xl:max-w-6xl 2xl:max-w-7xl mx-auto text-center">
            <div className="mb-8 md:mt-3 reveal-up">
              <div className="w-96 h-96 md:w-120 md:h-120 mx-auto rounded-full overflow-hidden bg-surface">
                <video 
                  ref={videoRef}
                  autoPlay 
                  loop 
                  muted 
                  playsInline
                  preload="metadata"
                  className="w-full h-full object-cover"
                  poster="/navi-midnight-black-hero-background-low.png"
                >
                  <source src="/navi-black-v4-hero-background.webm" type="video/webm" />
                  <ProgressiveImage
                    lowSrc="/navi-midnight-black-hero-background-low.png"
                    medSrc="/navi-midnight-black-hero-background-med.png"
                    highSrc="/navi-midnight-black-hero-background.png"
                    alt="Navi"
                    className="w-full h-full object-cover"
                  />
                </video>
              </div>
            </div>
          
          <div className="max-w-2xl mx-auto mb-12 reveal-up reveal-delay-1">
            <div className="bg-gradient-to-br from-[#272725] to-[#1f1f1d] border border-border/30 rounded-full p-4 shadow-lg max-w-lg">
              <div className="flex items-start gap-3">
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
                <div className="flex-1 min-h-[2rem]">
                  <p className="text-lg md:text-xl text-white leading-relaxed text-left drop-shadow-sm">
                    <span className="inline">
                      {typedText}<span className="animate-pulse">|</span>
                    </span>
                  </p>
                </div>
              </div>
            </div>
          </div>
          
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
          
        </div>
      </div>
      
      {/* Gradient overlay for depth */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background/100 to-transparent"></div>
    </section>
  );
};

export default HeroSection;