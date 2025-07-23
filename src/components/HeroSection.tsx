import { Button } from "@/components/ui/button";
import FloatingParticles from "./FloatingParticles";
import { useState, useEffect } from "react";

const HeroSection = () => {
  const [typedText, setTypedText] = useState("");
  const baseText = "Hi! I'm Navi, your voice AI ";
  const words = ["companion.", "daemon.", "assistant."];
  
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
              setTimeout(typeBase, 120);
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
          timeoutId = setTimeout(typeText, 100);
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
          timeoutId = setTimeout(typeText, 50);
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
        <div className="max-w-4xl mx-auto text-center">
          <div className="mb-8 reveal-up">
            <video 
              autoPlay 
              loop 
              muted 
              playsInline
              className="w-64 h-64 md:w-80 md:h-80 mx-auto object-cover rounded-full"
              poster="/navi-black.png"
            >
              <source src="/navi-black-v4-hero-background.webm" type="video/webm" />
              <img src="/navi-black.png" alt="Navi" className="w-full h-full object-cover" />
            </video>
          </div>
          
          <p className="text-2xl md:text-3xl text-foreground max-w-2xl mx-auto mb-12 leading-relaxed reveal-up reveal-delay-1 min-h-[6rem] text-center">
            <span className="inline">
              {typedText}<span className="animate-pulse">|</span>
            </span>
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
          
        </div>
      </div>
      
      {/* Gradient overlay for depth */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background/100 to-transparent"></div>
    </section>
  );
};

export default HeroSection;