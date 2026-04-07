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
// border color to encode the meaning, but the shape is always the same so
// users learn to recognize toasts as a single UI primitive.

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  success: 'border-2 border-success bg-[var(--color-panel)] text-foreground panel-shadow-sm',
  error: 'border-2 border-destructive bg-[var(--color-panel)] text-foreground panel-shadow-sm',
  info: 'border-2 border-brand bg-[var(--color-panel)] text-foreground panel-shadow-sm',
};

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
            className={`pointer-events-auto px-4 py-3 text-sm ${
              VARIANT_CLASSES[item.variant]
            } ${item.exiting ? 'toast-exit' : 'toast-enter'}`}
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
