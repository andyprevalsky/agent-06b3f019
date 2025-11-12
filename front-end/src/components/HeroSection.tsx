import { Button } from "@/components/ui/button";
import ProgressiveImage from "./ProgressiveImage";
import VideoPlayer from "./VideoPlayer";
import { useState, useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";

const HeroSection = () => {
  const [typedText, setTypedText] = useState("");
  const [shouldLoadVideo, setShouldLoadVideo] = useState(false);
  const [arrowVisible, setArrowVisible] = useState(true);
  const [isVideoReady, setIsVideoReady] = useState(false);
  const [hasPaintedFirstFrame, setHasPaintedFirstFrame] = useState(false);
  const [shouldBePlaying, setShouldBePlaying] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const circleRef = useRef<HTMLDivElement>(null);
  const arrowBtnRef = useRef<HTMLButtonElement>(null);
  const [typedTopSpacing, setTypedTopSpacing] = useState<number>(24);

  const baseText = "Hi! I'm Rose, your voice AI ";
  const words = ["companion.", "assistant.", "daemon.", "computer."];
  
  // Prioritize image loading, then allow video loading
  useEffect(() => {
    // Use requestAnimationFrame to ensure images start loading first
    // This gives images priority without artificial delays
    requestAnimationFrame(() => {
      setShouldLoadVideo(true);
    });
  }, []);
  // Keep typed text at 1/3 of the distance between circle bottom and arrow top
  useEffect(() => {
    const measure = () => {
      const circleEl = circleRef.current;
      const arrowEl = arrowBtnRef.current;
      if (!circleEl || !arrowEl) return;
      const circleRect = circleEl.getBoundingClientRect();
      const arrowRect = arrowEl.getBoundingClientRect();
      const distance = arrowRect.top - circleRect.bottom;
      if (!isFinite(distance)) return;
      const spacing = Math.max(12, Math.round(distance / 3));
      setTypedTopSpacing(spacing);
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', measure);
      window.visualViewport.addEventListener('scroll', measure);
    }
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', measure);
        window.visualViewport.removeEventListener('scroll', measure);
      }
    };
  }, [hasPaintedFirstFrame]);

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
      const isMobile = window.matchMedia('(max-width: 640px)').matches;
      // Reduce the gap on mobile to reclaim vertical space; keep desktop unchanged
      const topGap = Math.round(isMobile ? (hh + 4) : (hh + 8));
      if (sectionRef.current) {
        sectionRef.current.style.setProperty('--header-h', `${Math.round(hh)}px`);
        sectionRef.current.style.setProperty('--hero-top-gap', `${topGap}px`);
        // Tighter svh cap on small phones to ensure everything fits
        sectionRef.current.style.setProperty('--hero-svh-base', isMobile ? '65svh' : '75svh');
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
        if (shouldBePlaying) playVideo();
      }
    };

    const handleFocus = () => {
      if (shouldBePlaying) playVideo();
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
  }, [shouldLoadVideo, shouldBePlaying]);

  // Auto pause/resume hero video based on viewport visibility (watch the video element)
  useEffect(() => {
    const node = videoRef.current;
    if (!node) return;

    const io = new IntersectionObserver(([entry]) => {
      const visible = entry.isIntersecting && entry.intersectionRatio > 0;
      setShouldBePlaying(visible);
    }, { threshold: [0], rootMargin: '0px' });

    io.observe(node);
    return () => io.disconnect();
  }, [shouldLoadVideo]);

  // Apply desired play/pause state to the video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (shouldBePlaying) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [shouldBePlaying]);

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
    <section ref={sectionRef} className="relative z-10 flex flex-col items-center overflow-visible bg-background" style={{ height: '100svh', paddingTop: 'var(--hero-top-gap, calc(var(--header-h, 64px) + 8px))' }}>
      <div className="absolute inset-0 pointer-events-none z-20">
        <div className="absolute inset-0 grid-background"></div>
      </div>
      
      <div className="container mx-auto px-6 relative z-30 overflow-visible">
                  <div className="max-w-4xl xl:max-w-6xl 2xl:max-w-7xl mx-auto text-center overflow-visible">
            <div className="mb-8 md:mt-3 reveal-up flex justify-center">
              <div
                className="rounded-full p-2 bg-background flex items-center justify-center [--hero-circle-scale:1.15] sm:[--hero-circle-scale:1.2] lg:[--hero-circle-scale:1.125]"
                style={{
                  // Keep video/image at original size, enlarge only the circular background by 25%
                  ['--hero-video-size' as any]: 'clamp(300px, min(68vw, calc(var(--hero-svh-base, 75svh) - var(--hero-top-gap, 64px))), 480px)',
                  ['--hero-circle-size' as any]: 'calc(var(--hero-video-size) * var(--hero-circle-scale, 1.25))',
                  width: 'var(--hero-circle-size)',
                  height: 'var(--hero-circle-size)',
                  marginTop: 'clamp(8px, 3vh, 24px)'
                }}
              ref={circleRef}>
                <div className="rounded-full flex items-center justify-center relative" style={{ width: 'var(--hero-video-size)', height: 'var(--hero-video-size)' }}>
                  {/* Base image shown immediately */}
                  <ProgressiveImage
                    lowSrc="/navi-hero-image-low.png"
                    medSrc="/navi-hero-image-med.png"
                    highSrc="/navi-hero-image.png"
                    alt="Rose"
                    className="absolute inset-0 w-full h-full object-cover transform-gpu scale-[1.12] transition-opacity duration-150"
                    style={{ objectPosition: 'center center', opacity: hasPaintedFirstFrame ? 0 : 1 }}
                    fetchPriority="high"
                  />

                  {/* Video overlays the image; we only fade the image out to avoid video opacity flash */}
                  <VideoPlayer
                    ref={videoRef}
                    src="/navi-hero-animation.webm"
                    className="absolute inset-0 z-10 w-full h-full object-cover transform-gpu scale-[1.12]"
                    style={{ objectPosition: 'center center', visibility: hasPaintedFirstFrame ? 'visible' : 'hidden', backgroundColor: 'transparent' }}
                    objectFit="cover"
                    autoPlay={shouldBePlaying}
                    loop
                    muted
                    preload="auto"
                    poster="/navi-midnight-black-hero-background-low.png"
                    onLoad={() => setIsVideoReady(true)}
                    onFirstFrame={() => setHasPaintedFirstFrame(true)}
                  />
                </div>
              </div>
            </div>
          
          <div
            className="max-w-2xl mx-auto mb-12 reveal-up reveal-delay-1 flex justify-center"
            style={{ marginTop: `${typedTopSpacing}px` }}
          >
            <div className="relative z-40 backdrop-blur-none bg-gradient-to-br from-[#272725] to-[#1f1f1d] border border-border/30 rounded-full p-4 shadow-lg w-[420px]">
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
                  <p className="hero-typed-text text-base md:text-xl text-white leading-relaxed text-left drop-shadow-sm">
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
          ref={arrowBtnRef}
        >
          <ChevronDown className="w-6 h-6 text-white" />
        </button>
      </div>
      {/* Opaque base fill to mask grid between hero and ticker */}
      <div className="absolute bottom-0 left-0 right-0 h-48 bg-background z-0 pointer-events-none"></div>

      {/* Gradient overlay for depth */}
      <div className="absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-t from-background/100 to-transparent pointer-events-none z-10"></div>
    </section>
  );
};

export default HeroSection;