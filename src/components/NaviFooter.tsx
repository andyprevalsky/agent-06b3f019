const NaviFooter = () => {
  return (
    <footer className="bg-primary text-primary-foreground py-16">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
          
          <div className="md:col-span-2">
            <div className="flex items-center space-x-3 mb-4">
              <div className="w-8 h-8 rounded-lg" style={{ background: 'linear-gradient(to bottom left, #FD7706, #FD7706, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)' }}></div>
              <span className="text-xl font-semibold">Navi</span>
            </div>
            <p className="text-primary-foreground/70 max-w-md leading-relaxed">
              Transforming voice commands into infinite possibilities. 
              The first truly customizable AI hardware companion.
            </p>
          </div>
          
          <div>
            <h4 className="font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-primary-foreground/70">
              <li><a href="#features" className="hover:text-primary-foreground transition-colors">Features</a></li>
              <li><a href="#pre-order" className="hover:text-primary-foreground transition-colors">Pre-order</a></li>
              <li><a href="#" className="hover:text-primary-foreground transition-colors">Specifications</a></li>
              <li><a href="#" className="hover:text-primary-foreground transition-colors">Support</a></li>
            </ul>
          </div>
          
          <div>
            <h4 className="font-semibold mb-4">Company</h4>
            <ul className="space-y-2 text-primary-foreground/70">
              <li><a href="#" className="hover:text-primary-foreground transition-colors">About</a></li>
              <li><a href="#" className="hover:text-primary-foreground transition-colors">Privacy</a></li>
              <li><a href="#" className="hover:text-primary-foreground transition-colors">Terms</a></li>
              <li><a href="#" className="hover:text-primary-foreground transition-colors">Contact</a></li>
            </ul>
          </div>
          
        </div>
        
        <div className="border-t border-primary-foreground/10 pt-8">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <p className="text-primary-foreground/60 text-sm">
              © 2024 Navi. All rights reserved.
            </p>
            <div className="flex space-x-6 mt-4 md:mt-0">
              <a href="#" className="text-primary-foreground/60 hover:text-primary-foreground transition-colors text-sm">
                Privacy Policy
              </a>
              <a href="#" className="text-primary-foreground/60 hover:text-primary-foreground transition-colors text-sm">
                Terms of Service
              </a>
              <a href="#" className="text-primary-foreground/60 hover:text-primary-foreground transition-colors text-sm">
                Cookie Policy
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default NaviFooter;