import { Component, type ReactNode } from "react";

import { StatusPanel } from "./StatusPanel";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps the shell — and with it the always-visible not-a-medical-device line —
 * on screen when a route throws. A blank page is the one thing a monitoring
 * surface must never render: nothing at all reads as nothing wrong.
 */
export class RouteErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(cause: unknown): ErrorBoundaryState {
    return { error: cause instanceof Error ? cause : new Error(String(cause)) };
  }

  override render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <StatusPanel
        variant="error"
        headingLevel={1}
        title="This screen failed to render"
        detail={error.message}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}
