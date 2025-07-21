import NaviHeader from "@/components/NaviHeader";
import HeroSection from "@/components/HeroSection";
import PoweredByTicker from "@/components/PoweredByTicker";
import ProductShowcase from "@/components/ProductShowcase";
import FeaturesSection from "@/components/FeaturesSection";
import PreOrderSection from "@/components/PreOrderSection";
import CustomDesignForm from "@/components/CustomDesignForm";
import ServiceFeeSection from "@/components/ServiceFeeSection";
import NaviFooter from "@/components/NaviFooter";

const Index = () => {
  return (
    <div className="min-h-screen">
      <NaviHeader />
      <HeroSection />
      <PoweredByTicker />
      <ProductShowcase />
      <FeaturesSection />
      <PreOrderSection />
      <CustomDesignForm />
      <ServiceFeeSection />
      <NaviFooter />
    </div>
  );
};

export default Index;
