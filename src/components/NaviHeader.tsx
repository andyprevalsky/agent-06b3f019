import { Button } from "@/components/ui/button";

const NaviHeader = () => {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border/50">
      <div className="container mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg" style={{ background: 'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)' }}></div>
          <span className="text-xl font-semibold tracking-tight">Navi</span>
        </div>
        
        <nav className="hidden md:flex items-center space-x-8">
          <a href="#features" className="text-muted-foreground hover:text-foreground transition-colors">
            Features
          </a>
          <a href="#waitlist" className="text-muted-foreground hover:text-foreground transition-colors">
            Join Waitlist
          </a>
        </nav>
        
        <div className="flex items-center space-x-3">
          {/* Mobile Join Waitlist Button */}
          <Button 
            variant="default" 
            size="sm"
            className="md:hidden"
            onClick={() => {
              document.getElementById('waitlist')?.scrollIntoView({ 
                behavior: 'smooth' 
              });
            }}
          >
            Join Waitlist
          </Button>
          
          {/* Desktop Contact Button */}
          <Button 
            variant="outline" 
            size="sm"
            className="hidden md:flex border-border/50 hover:bg-secondary/50"
          >
            Contact
          </Button>
        </div>
      </div>
    </header>
  );
};

export default NaviHeader;