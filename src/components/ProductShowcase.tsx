const ProductShowcase = () => {
  return (
    <section className="py-24 bg-gradient-to-b from-background to-surface relative overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center max-w-6xl mx-auto">
          
          {/* Black Navi */}
          <div className="relative reveal-up">
            <img 
              src="/lovable-uploads/91e751a7-115a-416b-b7b3-9e7cee11584b.png" 
              alt="Navi in Midnight Black"
              className="w-3/4 h-auto mx-auto"
            />
            <div className="mt-8 text-center">
              <h3 className="text-2xl font-semibold mb-2">Midnight Black</h3>
              <p className="text-muted-foreground">Precision-crafted aluminum with a deep, sophisticated finish</p>
            </div>
          </div>
          
          {/* White Navi */}
          <div className="relative reveal-up reveal-delay-1">
            <img 
              src="/lovable-uploads/744124eb-2645-458e-8b89-dd1336ffb39c.png" 
              alt="Navi in Pearl White"
              className="w-3/4 h-auto mx-auto"
            />
            <div className="mt-8 text-center">
              <h3 className="text-2xl font-semibold mb-2">Pearl White</h3>
              <p className="text-muted-foreground">Lustrous ceramic-like finish that captures and reflects light</p>
            </div>
          </div>
          
        </div>
        
        <div className="text-center mt-16 reveal-up reveal-delay-2">
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Every Navi device is meticulously crafted with premium materials, 
            featuring precision-engineered perforations that optimize both acoustics and aesthetics.
          </p>
        </div>
      </div>
    </section>
  );
};

export default ProductShowcase;