/**
 * STATE MACHINE: ErrorBoundary (Class Component)
 *
 * [NORMAL] <-- hasError: false
 *   |
 *   | (child throws error)
 *   v
 * [ERROR_CAUGHT] <-- hasError: true, error: Error, errorInfo: ErrorInfo
 *   |
 *   +--> renders fallback or error UI
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  name?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[ErrorBoundary: ${this.props.name || 'Unknown'}] Caught error:`, error, errorInfo);
    this.setState({ error, errorInfo });
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <h2 className="text-red-800 font-semibold mb-2">
            ⚠️ Error in {this.props.name || 'Component'}
          </h2>
          <details className="text-sm text-red-700">
            <summary className="cursor-pointer">Show error details</summary>
            <pre className="mt-2 p-2 bg-red-100 rounded overflow-auto text-xs">
              {this.state.error?.toString()}
              {this.state.errorInfo?.componentStack}
            </pre>
          </details>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

