const ServiceFeeSection = () => {
  return (
    <section id="service-fee" className="py-16 bg-background">
      <div className="container mx-auto px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="bg-card/30 backdrop-blur-sm border border-border/30 rounded-lg p-8 opacity-60">
            <h3 className="text-lg font-medium mb-4 text-muted-foreground">AI Provider Services</h3>
            <p className="text-sm text-muted-foreground/80 mb-4">
              All Navi devices require AI provider services for optimal functionality. You have two options:
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
              <div className="text-left">
                <h4 className="font-medium text-muted-foreground mb-2">Provide Your Own API Keys</h4>
                <p className="text-muted-foreground/70">Use your existing OpenAI, Anthropic, or other provider accounts</p>
              </div>
              <div className="text-left">
                <h4 className="font-medium text-muted-foreground mb-2">Pay-as-You-Go Service</h4>
                <p className="text-muted-foreground/70">We handle everything at cost with no markup</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground/60 mt-4">
              Service charges cover AI provider costs only. We don't profit from this component.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};

export default ServiceFeeSection;