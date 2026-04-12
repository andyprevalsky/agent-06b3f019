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
import NaviFooter from '@/components/NaviFooter';
import HeroSection from './HeroSection';
import PoweredByTicker from './PoweredByTicker';
import FeaturesSection from './FeaturesSection';
import WaitlistSection from './WaitlistSection';
import PreOrderSection from './PreOrderSection';

import { useEarlyAccess } from '../hooks';

const Index = () => {
  const earlyAccess = useEarlyAccess();
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
