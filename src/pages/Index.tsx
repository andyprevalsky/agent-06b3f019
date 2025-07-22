import NaviHeader from "@/components/NaviHeader";
import HeroSection from "@/components/HeroSection";
import PoweredByTicker from "@/components/PoweredByTicker";
import ProductShowcase from "@/components/ProductShowcase";
import FeaturesSection from "@/components/FeaturesSection";
import PreOrderSection from "@/components/PreOrderSection";
import CustomDesignForm from "@/components/CustomDesignForm";
import { MemoryGraphAnimation } from "@/components/MemoryGraphAnimation";
import NaviFooter from "@/components/NaviFooter";

const Index = () => {
  return (
    <div className="min-h-screen">
      <NaviHeader />
      <HeroSection />
      <PoweredByTicker />
      <ProductShowcase />
      <FeaturesSection />
      
      {/* Memory Growth Animation Section */}
      <section className="py-24 bg-background relative">
        <div className="container mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-5xl font-light tracking-tight mb-6 reveal-up">
              <span className="gradient-text">Memory That Grows</span>
            </h2>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto reveal-up reveal-delay-1">
              Watch how Navi builds a network of memories, forming connections that help it understand you better over time
            </p>
          </div>
          
          <div className="max-w-4xl mx-auto">
            <MemoryGraphAnimation />
          </div>
        </div>
      </section>
      
      <PreOrderSection />
      <CustomDesignForm />
      
      <NaviFooter />
    </div>
  );
};

export default Index;
