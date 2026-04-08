/**
 * STATE MACHINE: Index (Landing Page)
 *
 * This component is stateless - computes earlyAccess from utils.
 *
 * [MOUNTED]
 *   |
 *   +--> earlyAccess=true --> shows PreOrderSection + WaitlistSection(customOnly)
 *   +--> earlyAccess=false --> shows WaitlistSection only
 */

import { Toaster } from '@/components/ui/toaster';
import NaviHeader from '@/components/NaviHeader';
import HeroSection from '@/components/HeroSection';
import PoweredByTicker from '@/components/PoweredByTicker';
import FeaturesSection from '@/components/FeaturesSection';
import WaitlistSection from '@/components/WaitlistSection';
import PreOrderSection from '@/components/PreOrderSection';
import { isEarlyAccessEnabled } from '@/lib/utils';

import NaviFooter from '@/components/NaviFooter';

const Index = () => {
  const earlyAccess = isEarlyAccessEnabled();
  return (
    <div className="min-h-screen overflow-visible">
      <NaviHeader />
      <HeroSection />
      <PoweredByTicker />
      <FeaturesSection />
      {earlyAccess && <PreOrderSection />}
      <WaitlistSection customOnly={earlyAccess} />
      <NaviFooter />
      <Toaster />
    </div>
  );
};

export default Index;
