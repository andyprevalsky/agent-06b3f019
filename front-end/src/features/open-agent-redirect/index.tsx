/**
 * STATE MACHINE: OpenAgentRedirect
 *
 * Deep-link alias for durable bench/RCA evidence URLs.
 *
 * [MOUNTED] --> read ?agent-id
 *   |
 *   +--> missing/empty --> replace to "/"
 * Exact attention/task locators survive the alias redirect for authenticated validation.
 *   +--> present --> replace to "/?agent-id=<id>" (Terminal deep link)
 *
 * Why: `/open-agent` is the hub/archive redirect path and the durable URL we
 * published in RCA Evidence, but the production SPA route table had no match
 * so React rendered NotFound ("Oops! Page not found") while HTTP stayed 200.
 */

import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

export default function OpenAgentRedirect() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  useEffect(() => {
    const agentId = (params.get('agent-id') || '').trim();
    if (!agentId) {
      navigate('/', { replace: true });
      return;
    }
    const destination = new URL('/', window.location.origin);
    destination.searchParams.set('agent-id', agentId);
    for (const key of ['browser-id', 'attention-request-id']) {
      const value = params.get(key);
      if (value) destination.searchParams.set(key, value);
    }
    navigate(`${destination.pathname}${destination.search}`, { replace: true });
  }, [navigate, params]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <p className="text-sm text-gray-600">Opening agent…</p>
    </div>
  );
}
