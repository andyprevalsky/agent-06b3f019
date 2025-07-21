import { Button } from "@/components/ui/button";
import naviEmblem from "@/assets/navi-gradient-emblem.png";

const NaviHeader = () => {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border/50">
      <div className="container mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <img src={naviEmblem} alt="Navi" className="w-8 h-8" />
          <span className="text-xl font-semibold tracking-tight">Navi</span>
        </div>
        
        <nav className="hidden md:flex items-center space-x-8">
          <a href="#features" className="text-muted-foreground hover:text-foreground transition-colors">
            Features
          </a>
          <a href="#pre-order" className="text-muted-foreground hover:text-foreground transition-colors">
            Pre-order
          </a>
        </nav>
        
        <Button 
          variant="outline" 
          size="sm"
          className="hidden md:flex border-border/50 hover:bg-secondary/50"
        >
          Contact
        </Button>
      </div>
    </header>
  );
};

export default NaviHeader;