import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/** Logs a 404 error with the attempted pathname on mount. */
export function useNotFoundLogging(): void {
  const location = useLocation();

  useEffect(() => {
    console.error('404 Error: User attempted to access non-existent route:', location.pathname);
  }, [location.pathname]);
}
