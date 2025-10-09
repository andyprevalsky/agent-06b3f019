import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { Toaster } from '@/components/ui/toaster'
import { Toaster as Sonner } from '@/components/ui/sonner'
import './index.css'

// Fix iOS Safari viewport height issues
const setVH = () => {
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
};

// Set initial value
setVH();

// Update on resize and orientation change
window.addEventListener('resize', setVH);
window.addEventListener('orientationchange', () => {
  setTimeout(setVH, 100);
});

// Handle iOS Safari viewport changes more aggressively
if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
  // Handle Safari's dynamic UI
  if (window.visualViewport) {
    const updateVH = () => {
      const vh = window.visualViewport!.height * 0.01;
      document.documentElement.style.setProperty('--vh', `${vh}px`);
    };
    
    window.visualViewport.addEventListener('resize', updateVH);
    window.visualViewport.addEventListener('scroll', updateVH);
  }
  
  // Additional iOS specific events
  window.addEventListener('focus', () => setTimeout(setVH, 100));
  window.addEventListener('blur', () => setTimeout(setVH, 100));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(setVH, 100);
  });
}

// Render main app
createRoot(document.getElementById("root")!).render(<App />);

// Render toasters outside of root to avoid z-index stacking context issues
const toasterContainer = document.createElement('div');
toasterContainer.id = 'toaster-portal';
document.body.appendChild(toasterContainer);
createRoot(toasterContainer).render(
  <>
    <Toaster />
    <Sonner />
  </>
);
