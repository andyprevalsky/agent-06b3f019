const ProductShowcase = () => {
  return (
    <section className="py-24 bg-gradient-to-b from-background to-surface relative overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center max-w-6xl mx-auto mb-24">
          
          {/* Black Navi */}
          <div className="relative reveal-up">
            <img 
              src="/navi-black.png" 
              alt="Navi in Midnight Black"
              className="w-3/4 h-auto mx-auto"
            />
            <div className="mt-4 text-center">
              <h3 className="text-2xl font-semibold mb-2">Midnight Black</h3>
              <p className="text-muted-foreground">Precision-crafted aluminum with a deep, sophisticated finish</p>
            </div>
          </div>
          
          {/* White Navi */}
          <div className="relative reveal-up reveal-delay-1">
            <img 
              src="/navi-white.png" 
              alt="Navi in Pearl White"
              className="w-3/4 h-auto mx-auto"
            />
            <div className="mt-4 text-center">
              <h3 className="text-2xl font-semibold mb-2">Pearl White</h3>
              <p className="text-muted-foreground">Lustrous ceramic-like finish that captures and reflects light</p>
            </div>
          </div>
          
        </div>
        
        {/* Custom Design Section */}
        <div className="text-center mt-24 reveal-up reveal-delay-3">
          <img 
            src="https://images.unsplash.com/photo-1488590528505-98d2b5aba04b?w=600&h=400&fit=crop&crop=center" 
            alt="Custom Design Navi"
            className="w-1/2 lg:w-1/3 h-auto mx-auto rounded-lg mb-6"
          />
          <h3 className="text-2xl font-semibold mb-2">Custom Design</h3>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Bring your unique vision to life with a personalized Navi device. From custom colors to unique patterns, 
            we'll work with you to create something truly one-of-a-kind.
          </p>
        </div>
      </div>
    </section>
  );
};

export default ProductShowcase;