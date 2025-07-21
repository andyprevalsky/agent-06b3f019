const ProductShowcase = () => {
  return (
    <section className="py-24 bg-gradient-to-b from-background to-surface relative overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center max-w-6xl mx-auto mb-24">
          
          {/* Black Navi */}
          <div className="relative reveal-up">
            <img 
              src="/lovable-uploads/91e751a7-115a-416b-b7b3-9e7cee11584b.png" 
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
              src="/lovable-uploads/08d900d5-b4c6-43d7-8e90-87a13069cd14.png" 
              alt="Navi in Pearl White"
              className="w-3/4 h-auto mx-auto"
            />
            <div className="mt-4 text-center">
              <h3 className="text-2xl font-semibold mb-2">Pearl White</h3>
              <p className="text-muted-foreground">Lustrous ceramic-like finish that captures and reflects light</p>
            </div>
          </div>
          
        </div>
        
        <div className="text-center mt-16 mb-16 reveal-up reveal-delay-2">
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Every Navi device is meticulously crafted with premium materials, 
            featuring precision-engineered perforations that optimize both acoustics and aesthetics.
          </p>
        </div>

        {/* AI Provider Service Information */}
        <div className="mt-24 reveal-up reveal-delay-3">
          <div className="bg-card/50 backdrop-blur-sm border border-border/50 rounded-lg p-8 max-w-4xl mx-auto">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-center">
              <div>
                <h3 className="text-2xl font-semibold mb-4">AI Provider Services</h3>
                <p className="text-muted-foreground mb-4">
                  All Navi devices require AI provider services for optimal functionality. You have two options:
                </p>
                <ul className="text-muted-foreground space-y-2 mb-4">
                  <li>• <strong>Provide your own API keys</strong> - Use your existing accounts</li>
                  <li>• <strong>Pay-as-you-go service</strong> - We handle everything at cost (no markup)</li>
                </ul>
                <p className="text-sm text-muted-foreground/80">
                  Service charges cover AI provider costs only. We don't profit from this component.
                </p>
              </div>
              <div className="flex justify-center">
                <img 
                  src="https://images.unsplash.com/photo-1518770660439-4636190af475?w=400&h=300&fit=crop&crop=center" 
                  alt="AI Technology"
                  className="w-3/4 h-auto rounded-lg"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Custom Design Section */}
        <div className="text-center mt-24 reveal-up reveal-delay-4">
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