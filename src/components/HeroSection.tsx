import { Button } from "@/components/ui/button";
import FloatingParticles from "./FloatingParticles";
import ProgressiveImage from "./ProgressiveImage";
import VideoPlayer from "./VideoPlayer";
import { useState, useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";

const HeroSection = () => {
  const [typedText, setTypedText] = useState("");
  const [shouldLoadVideo, setShouldLoadVideo] = useState(false);
  const [arrowVisible, setArrowVisible] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

  const baseText = "Hi! I'm Navi, your voice AI ";
  const words = ["companion.", "assistant.", "daemon.", "computer."];
  
  // Prioritize image loading, then allow video loading
  useEffect(() => {
    // Use requestAnimationFrame to ensure images start loading first
    // This gives images priority without artificial delays
    requestAnimationFrame(() => {
      setShouldLoadVideo(true);
    });
  }, []);

  // Show arrow only while hero is in view
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      setArrowVisible(entry.isIntersecting);
    }, { threshold: [0, 0.01] });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Measure header height to keep consistent gap and avoid clipping
  useEffect(() => {
    const updateHeaderH = () => {
      const hh = document.getElementById('site-header')?.getBoundingClientRect().height ?? 64;
      if (sectionRef.current) {
        sectionRef.current.style.setProperty('--header-h', `${Math.round(hh)}px`);
      }
    };
    updateHeaderH();
    window.addEventListener('resize', updateHeaderH);
    window.addEventListener('orientationchange', updateHeaderH);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateHeaderH);
      window.visualViewport.addEventListener('scroll', updateHeaderH);
    }
    return () => {
      window.removeEventListener('resize', updateHeaderH);
      window.removeEventListener('orientationchange', updateHeaderH);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', updateHeaderH);
        window.visualViewport.removeEventListener('scroll', updateHeaderH);
      }
    };
  }, []);

  // Handle Safari iOS video issues - only after video should load
  useEffect(() => {
    if (!shouldLoadVideo) return;
    
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
  }, [shouldLoadVideo]);

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



  return (
    <section ref={sectionRef} className="relative flex flex-col items-center overflow-visible bg-gradient-to-br from-background via-surface to-secondary/30 grid-background" style={{ height: '100svh', paddingTop: 'calc(var(--header-h, 64px) + 8px)' }}>
      <FloatingParticles />
      
      <div className="container mx-auto px-6 relative z-10 overflow-visible">
                  <div className="max-w-4xl xl:max-w-6xl 2xl:max-w-7xl mx-auto text-center overflow-visible">
            <div className="mb-8 md:mt-3 reveal-up flex justify-center">
              <div
                className="rounded-full p-2 bg-surface flex items-center justify-center"
                style={{
                  width: 'clamp(240px, min(70vw, 60vh), 640px)',
                  height: 'clamp(240px, min(70vw, 60vh), 640px)',
                  marginTop: 'clamp(8px, 3vh, 24px)'
                }}
              >
                <div className="rounded-full w-full h-full flex items-center justify-center">
                  {shouldLoadVideo ? (
                    <VideoPlayer
                      ref={videoRef}
                      src="/navi-hero-animation.webm"
                      className="w-full h-full object-cover"
                      style={{ objectPosition: 'center center' }}
                      objectFit="cover"
                      autoPlay={true}
                      loop={true}
                      muted={true}
                      preload="none"
                      poster="/navi-midnight-black-hero-background-low.png"
                      fallbackContent={
                        <ProgressiveImage
                          lowSrc="/navi-hero-image-low.png"
                          medSrc="/navi-hero-image-med.png"
                          highSrc="/navi-hero-image.png"
                          alt="Navi"
                          className="w-full h-full object-cover"
                          style={{ objectPosition: 'center center' }}
                          fetchPriority="high"
                        />
                      }
                    />
                  ) : (
                    <ProgressiveImage
                      lowSrc="/navi-hero-image-low.png"
                      medSrc="/navi-hero-image-med.png"
                      highSrc="/navi-hero-image.png"
                      alt="Navi"
                      className="w-full h-full object-cover"
                      style={{ objectPosition: 'center center' }}
                      fetchPriority="high"
                    />
                  )}
                </div>
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
      
      {/* Scroll down arrow - fixed to prevent layout shift */}
      <div className={`absolute left-1/2 transform -translate-x-1/2 z-30 transition-opacity duration-200 ${arrowVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} style={{ bottom: 'clamp(2px, calc(env(safe-area-inset-bottom, 0px) + 2px), 12px)' }}>
        <button 
          className="p-3 rounded-full bg-gradient-to-br from-[#272725] to-[#1f1f1d] border border-border/30 hover:bg-gradient-to-br hover:from-[#323230] hover:to-[#252523] transition-all duration-300 shadow-lg animate-slow-bounce"
          onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}
          aria-label="Scroll to features"
        >
          <ChevronDown className="w-6 h-6 text-white" />
        </button>
      </div>
      
      {/* Gradient overlay for depth */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background/100 to-transparent pointer-events-none z-10"></div>
    </section>
  );
};

export default HeroSection;