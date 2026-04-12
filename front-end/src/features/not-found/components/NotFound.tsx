/**
 * STATE MACHINE: NotFound
 *
 * This component is stateless - displays static 404 error content.
 * Only side effect: logs 404 error on mount.
 *
 * [MOUNTED] --> logs error --> renders static content
 */

import { useNotFoundLogging } from '../hooks';

const NotFound = () => {
  useNotFoundLogging();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">404</h1>
        <p className="text-xl text-gray-600 mb-4">Oops! Page not found</p>
        <a href="/" className="text-blue-500 hover:text-blue-700 underline">
          Return to Home
        </a>
      </div>
    </div>
  );
};

export default NotFound;
