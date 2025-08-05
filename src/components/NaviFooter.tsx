import { useState } from "react";
import ContactModal from "./ContactModal";

const NaviFooter = () => {
  const [contactModalOpen, setContactModalOpen] = useState(false);
  return (
    <footer className="bg-primary text-primary-foreground py-16">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
          
          <div className="md:col-span-2">
            <a href="/" className="flex items-center space-x-3 mb-4 hover:opacity-80 transition-opacity w-fit">
              <div className="w-8 h-8 rounded-lg" style={{ background: 'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)' }}></div>
              <span className="text-xl font-semibold">Navi</span>
            </a>
            <p className="text-primary-foreground/70 max-w-md leading-relaxed">
              Lighting the way to what matters most. Navi is the first truly customizable AI hardware companion.
            </p>
          </div>
          
          <div>
            <h4 className="font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-primary-foreground/70">
              <li>
                <button 
                  onClick={() => {
                    if (window.location.pathname === '/') {
                      document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' });
                    } else {
                      window.location.href = '/#features';
                    }
                  }}
                  className="hover:text-primary-foreground transition-colors text-left"
                >
                  Features
                </button>
              </li>
              <li>
                <button 
                  onClick={() => {
                    if (window.location.pathname === '/') {
                      document.getElementById('waitlist')?.scrollIntoView({ behavior: 'smooth' });
                    } else {
                      window.location.href = '/#waitlist';
                    }
                  }}
                  className="hover:text-primary-foreground transition-colors text-left"
                >
                  Join Waitlist
                </button>
              </li>
            </ul>
          </div>
          
          <div>
            <h4 className="font-semibold mb-4">Company</h4>
            <ul className="space-y-2 text-primary-foreground/70">
              <li><a href="#" className="hover:text-primary-foreground transition-colors">About</a></li>
              <li><a href="/privacy" className="hover:text-primary-foreground transition-colors">Privacy</a></li>
              <li><a href="/terms" className="hover:text-primary-foreground transition-colors">Terms</a></li>
              <li>
                <button 
                  onClick={() => setContactModalOpen(true)}
                  className="hover:text-primary-foreground transition-colors text-left"
                >
                  Contact
                </button>
              </li>
            </ul>
          </div>
          
        </div>
        
        <div className="border-t border-primary-foreground/10 pt-8">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <p className="text-primary-foreground/60 text-sm">
              © 2025 Navi. All rights reserved.
            </p>
            <div className="flex space-x-6 mt-4 md:mt-0">
              <a href="/privacy" className="text-primary-foreground/60 hover:text-primary-foreground transition-colors text-sm">
                Privacy Policy
              </a>
              <a href="/terms" className="text-primary-foreground/60 hover:text-primary-foreground transition-colors text-sm">
                Terms of Service
              </a>
              <a href="#" className="text-primary-foreground/60 hover:text-primary-foreground transition-colors text-sm">
                Cookie Policy
              </a>
            </div>
          </div>
        </div>
      </div>
      
      <ContactModal 
        open={contactModalOpen} 
        onOpenChange={setContactModalOpen} 
      />
    </footer>
  );
};

export default NaviFooter;