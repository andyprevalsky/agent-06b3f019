const ProductShowcase = () => {
  return (
    <section className="py-24 bg-gradient-to-b from-background to-surface relative overflow-hidden">
      <div className="container mx-auto px-6">
        {/* Custom Design Section */}
        <div className="text-center reveal-up">
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