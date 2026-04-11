/**
 * STATE MACHINE: ProtectedRoute
 *
 * [LOADING] <-- loading: true
 *     |
 *     v (auth check complete)
 * [CHECKING_AUTH]
 *     |
 *     +--> user exists --> [AUTHORIZED] --> renders children
 *     +--> no user --> [REDIRECTING] --> navigate('/') --> returns null
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

import type { ProtectedRouteProps } from '../types';

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !user) {
      navigate('/');
    }
  }, [user, loading, navigate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-gray-900" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return <>{children}</>;
}
