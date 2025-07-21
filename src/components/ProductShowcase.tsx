const ProductShowcase = () => {
  return (
    <section className="py-24 bg-gradient-to-b from-background to-surface relative overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center max-w-6xl mx-auto">
          
          {/* Black Navi */}
          <div className="relative reveal-up">
            <div className="relative bg-card rounded-3xl p-12">
              <img 
                src="/lovable-uploads/62a020ea-47e5-4023-ad55-7b6466acd665.png" 
                alt="Navi in Midnight Black"
                className="w-full h-auto"
              />
              <div className="mt-8 text-center">
                <h3 className="text-2xl font-semibold mb-2">Midnight Black</h3>
                <p className="text-muted-foreground">Precision-crafted aluminum with a deep, sophisticated finish</p>
              </div>
            </div>
          </div>
          
          {/* White Navi */}
          <div className="relative reveal-up reveal-delay-1">
            <div className="relative bg-surface-elevated rounded-3xl p-12">
              <img 
                src="/lovable-uploads/1a447f91-b21f-4746-9f75-278db25daedd.png" 
                alt="Navi in Pearl White"
                className="w-full h-auto"
              />
              <div className="mt-8 text-center">
                <h3 className="text-2xl font-semibold mb-2">Pearl White</h3>
                <p className="text-muted-foreground">Lustrous ceramic-like finish that captures and reflects light</p>
              </div>
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