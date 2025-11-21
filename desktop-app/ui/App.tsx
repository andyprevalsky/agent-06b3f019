import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { Integrations } from './components/Integrations';
import { AuthModal } from './components/AuthModal';
import { useAuth } from './hooks/useAuth';

export default function App() {
  const { user, loading } = useAuth();
  const [showAuthModal, setShowAuthModal] = useState(false);
  
  useEffect(() => {
    if (!loading && !user) {
      setShowAuthModal(true);
    }
  }, [user, loading]);
  
  return (
    <div className="flex h-screen">
      <Sidebar onShowAuth={() => setShowAuthModal(true)} />
      <Integrations />
      
      {showAuthModal && (
        <AuthModal 
          onClose={() => setShowAuthModal(false)}
          onSuccess={() => setShowAuthModal(false)}
        />
      )}
    </div>
  );
}


