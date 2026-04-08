'use client';

import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  exiting: boolean;
}

interface ToastOptions {
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. Default 2500 (success/info) / 5000 (error). */
  duration?: number;
}

interface ToastContextValue {
  toast: (message: string, options?: ToastOptions) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

// ---------------------------------------------------------------------------
// Variant styling
// ---------------------------------------------------------------------------
//
// Sharp-corner comic vocabulary: thick border in the variant tone, panel
// background, neo-brutalist offset shadow. Each variant gets a different
// border color AND a leading SVG icon — border alone was too subtle at
// glance, especially with the gold/red palette. Icon is the first signal
// the eye picks up, the colour reinforces it.

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  success: 'border-2 border-success bg-[var(--color-panel)] text-foreground panel-shadow-sm',
  error: 'border-2 border-destructive bg-[var(--color-panel)] text-foreground panel-shadow-sm',
  info: 'border-2 border-brand bg-[var(--color-panel)] text-foreground panel-shadow-sm',
};

const VARIANT_ICON_CLASS: Record<ToastVariant, string> = {
  success: 'text-success',
  error: 'text-destructive',
  info: 'text-brand',
};

// Inline SVG icons (16x16, currentColor) so they pick up the variant
// tint via VARIANT_ICON_CLASS. Aria-hidden because the variant is
// announced via the surrounding aria-live region; the icon is purely
// visual reinforcement.
function VariantIcon({ variant }: { variant: ToastVariant }) {
  const className = `h-4 w-4 shrink-0 ${VARIANT_ICON_CLASS[variant]}`;
  if (variant === 'success') {
    return (
      <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="3 8 7 12 13 4" />
      </svg>
    );
  }
  if (variant === 'error') {
    return (
      <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="4" y1="4" x2="12" y2="12" />
        <line x1="12" y1="4" x2="4" y2="12" />
      </svg>
    );
  }
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="4" r="0.5" fill="currentColor" />
      <line x1="8" y1="7" x2="8" y2="13" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idCounter = useRef(0);
  // Track active timeouts so we can clean them up on unmount
  const timeouts = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const toast = useCallback((message: string, options?: ToastOptions) => {
    const variant = options?.variant ?? 'success';
    const duration = options?.duration ?? (variant === 'error' ? 5000 : 2500);

    const id = ++idCounter.current;
    setItems((prev) => [...prev, { id, message, variant, exiting: false }]);

    // Start exit animation after duration
    const exitTimer = setTimeout(() => {
      setItems((prev) =>
        prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
      );
      timeouts.current.delete(exitTimer);
    }, duration);
    timeouts.current.add(exitTimer);

    // Remove from DOM after exit animation completes
    const removeTimer = setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
      timeouts.current.delete(removeTimer);
    }, duration + 200);
    timeouts.current.add(removeTimer);
  }, []);

  // Clear all pending timers on unmount
  useEffect(() => {
    const timers = timeouts.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}

      {/* Toast container — fixed bottom-right.
          role=status + aria-live=polite so screen readers announce new items. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className={`pointer-events-auto flex items-start gap-2.5 px-4 py-3 text-sm ${
              VARIANT_CLASSES[item.variant]
            } ${item.exiting ? 'toast-exit' : 'toast-enter'}`}
          >
            <span className="mt-0.5">
              <VariantIcon variant={item.variant} />
            </span>
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
