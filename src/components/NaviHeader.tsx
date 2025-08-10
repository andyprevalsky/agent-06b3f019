import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import ContactModal from "./ContactModal";

const NaviHeader = () => {
  const [showMobileButton, setShowMobileButton] = useState(false);
  const [contactModalOpen, setContactModalOpen] = useState(false);

  useEffect(() => {
    const featuresSection = document.getElementById('features');
    if (!featuresSection) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.target.id === 'features') {
            setShowMobileButton(entry.isIntersecting);
          }
        });
      },
      {
        threshold: 0.1, // Trigger when 10% of the features section is visible
        rootMargin: '-50px 0px' // Account for the fixed header height
      }
    );

    observer.observe(featuresSection);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <header id="site-header" className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border/50">
      <div className="container mx-auto px-6 h-16 flex items-center justify-between">
        <a href="/" className="flex items-center space-x-3 hover:opacity-80 transition-opacity">
          <div className="w-8 h-8 rounded-lg" style={{ background: 'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)' }}></div>
          <span className="text-xl font-semibold tracking-tight">Navi</span>
        </a>
        
        <nav className="hidden md:flex items-center space-x-8">
          <button 
            onClick={() => {
              if (window.location.pathname === '/') {
                document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' });
              } else {
                window.location.href = '/#features';
              }
            }}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Features
          </button>
          <button 
            onClick={() => {
              if (window.location.pathname === '/') {
                document.getElementById('waitlist')?.scrollIntoView({ behavior: 'smooth' });
              } else {
                window.location.href = '/#waitlist';
              }
            }}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Join Waitlist
          </button>
          <a href="/about" className="text-muted-foreground hover:text-foreground transition-colors">About</a>
        </nav>
        
        <div className="flex items-center space-x-3">
          {/* Mobile Join Waitlist Button - Reserve space to prevent layout shift */}
          <button 
            className={`relative md:hidden px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 overflow-hidden hover:scale-105 ${
              showMobileButton ? 'opacity-100 visible' : 'opacity-0 invisible'
            }`}
            onClick={() => {
              if (window.location.pathname === '/') {
                document.getElementById('waitlist')?.scrollIntoView({ behavior: 'smooth' });
              } else {
                window.location.href = '/#waitlist';
              }
            }}
          >
            <div className="absolute inset-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC] bg-[length:200%_200%] animate-gradient-rotate rounded-lg">
            </div>
            <span className="relative text-white z-10">Join Waitlist</span>
          </button>
          
          {/* Desktop Contact Button */}
          <Button 
            variant="outline" 
            size="sm"
            className="hidden md:flex border-border/50 hover:bg-secondary/50"
            onClick={() => setContactModalOpen(true)}
          >
            Contact
          </Button>
        </div>
      </div>
      
      <ContactModal 
        open={contactModalOpen} 
        onOpenChange={setContactModalOpen} 
      />
    </header>
  );
};

export default NaviHeader;