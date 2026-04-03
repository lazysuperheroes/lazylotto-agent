'use client';

import { createContext, useContext, useState, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToastItem {
  id: number;
  message: string;
  exiting: boolean;
}

interface ToastContextValue {
  toast: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idCounter = useRef(0);

  const toast = useCallback((message: string) => {
    const id = ++idCounter.current;
    setItems((prev) => [...prev, { id, message, exiting: false }]);

    // Start exit animation after 2.5s
    setTimeout(() => {
      setItems((prev) =>
        prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
      );
    }, 2500);

    // Remove from DOM after exit animation completes
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 2700);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}

      {/* Toast container — fixed bottom-right */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            className={`pointer-events-auto rounded-lg bg-success px-4 py-2.5 text-sm font-medium text-white shadow-lg ${
              item.exiting ? 'toast-exit' : 'toast-enter'
            }`}
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
