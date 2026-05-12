/**
 * HashRouter + Route table for the onboarded-user flow.
 *
 * Kept in its own component so the shell (ElectronAppInner) can render it
 * unconditionally once the user is fully signed in and onboarded, without
 * pulling router plumbing into the decision-tree logic.
 *
 * HashRouter (not BrowserRouter) because Electron loads the renderer from
 * file:// URLs which BrowserRouter cannot handle.
 */

import { HashRouter, Routes, Route } from 'react-router-dom';
import Terminal from '@/pages/Terminal';
import Browse from '@/pages/Browse';
import Privacy from '@/pages/Privacy';
import Terms from '@/pages/Terms';
import NotFound from '@/pages/NotFound';

const AppRoutes = () => {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Terminal />} />
        <Route path="/browse" element={<Browse />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </HashRouter>
  );
};

export default AppRoutes;
