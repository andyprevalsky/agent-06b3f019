import { Plug, LogOut, LogIn } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

interface SidebarProps {
  onShowAuth: () => void;
}

export function Sidebar({ onShowAuth }: SidebarProps) {
  const { user, signOut } = useAuth();
  
  return (
    <aside 
      className="w-64 h-full border-r border-border/50 flex flex-col bg-white/80 dark:bg-navi-black/80"
      style={{
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      {/* Logo */}
      <div className="p-6">
        <h1 className="text-2xl font-bold">Navi Desktop</h1>
        <p className="text-sm text-muted-foreground mt-1">Integration Uploader</p>
      </div>
      
      {/* Integrations (active) */}
      <div className="flex-1 px-3">
        <div className="px-3 py-2 rounded-lg bg-muted">
          <div className="flex items-center gap-2">
            <Plug className="h-4 w-4" />
            <span className="font-medium">Integrations</span>
          </div>
        </div>
      </div>
      
      {/* Auth Button */}
      <div className="border-t border-border p-3">
        {user ? (
          <button 
            onClick={signOut}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-muted transition-colors"
          >
            <LogOut className="h-4 w-4" />
            <span>Logout</span>
          </button>
        ) : (
          <button 
            onClick={onShowAuth}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-muted transition-colors"
          >
            <LogIn className="h-4 w-4" />
            <span>Login</span>
          </button>
        )}
      </div>
    </aside>
  );
}


