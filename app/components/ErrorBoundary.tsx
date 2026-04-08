'use client';

import { Component, type ReactNode, type ErrorInfo } from 'react';

// ---------------------------------------------------------------------------
// ErrorBoundary
// ---------------------------------------------------------------------------
//
// Per-section error containment. Wrap each ComicPanel block in one of
// these so a single failing renderer (e.g. NaN slipping into a number
// formatter, a missing field in a stale cached payload) doesn't blow
// up the entire dashboard into the spartan app/error.tsx page.
//
// Why we need a class component:
//   React error boundaries can ONLY be class components until the
//   experimental hooks-based variants ship. Keep this component small,
//   focused, and isolated from feature code.
//
// Usage:
//
//   <ErrorBoundary
//     label="Recent plays"
//     onReset={() => setHistoryLoading(true)}
//   >
//     <RecentPlays />
//   </ErrorBoundary>
//
// The fallback shows a small, dignified failure card with a Try
// again button that resets boundary state. The user can keep using
// the rest of the page while one section recovers (or doesn't).
//
// ── Logging ─────────────────────────────────────────────────────
//
// componentDidCatch logs to console with the section label so the
// dev tools clearly show which boundary caught what. Production
// logging should go through whatever observability layer the app
// has — left as a hook for the caller via the optional onError prop.

interface ErrorBoundaryProps {
  /** Short human label shown in the fallback ("Recent plays", "Pending claim", ...). */
  label: string;
  /** Optional reset hook — runs when the user clicks "Try again". */
  onReset?: () => void;
  /** Optional error sink — fired with (error, errorInfo) on catch. */
  onError?: (error: Error, info: ErrorInfo) => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info);
    this.props.onError?.(error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="my-6 border-2 border-destructive bg-destructive/5 px-5 py-4"
        >
          <p className="label-caps-destructive mb-2">
            {this.props.label} unavailable
          </p>
          <p className="mb-3 text-sm text-foreground">
            This section failed to render. The rest of the page is unaffected.
          </p>
          <p className="mb-4 break-words font-mono text-xs text-muted">
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={this.reset}
            className="border-2 border-destructive px-3 py-1.5 label-caps-destructive transition-colors hover:bg-destructive/20"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
