import { Toaster } from "@/components/ui/toaster";
import NaviHeader from "@/components/NaviHeader";
import HeroSection from "@/components/HeroSection";
import FeaturesSection from "@/components/FeaturesSection";
import WaitlistSection from "@/components/WaitlistSection";
import ProductShowcase from "@/components/ProductShowcase";
import ServiceFeeSection from "@/components/ServiceFeeSection";
import NaviFooter from "@/components/NaviFooter";

const Index = () => {
  return (
    <div className="min-h-screen">
      <NaviHeader />
      <HeroSection />
      <FeaturesSection />
      <WaitlistSection />
      <ProductShowcase />
      <ServiceFeeSection />
      <NaviFooter />
      <Toaster />
    </div>
  );
};

export default Index;
