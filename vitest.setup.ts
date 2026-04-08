/**
 * Vitest setup — runs before each test file.
 *
 * Imports @testing-library/jest-dom matchers (toBeInTheDocument,
 * toHaveAttribute, etc.) and any global polyfills the React
 * components expect.
 */

import '@testing-library/jest-dom/vitest';

// Polyfill window.matchMedia which jsdom doesn't ship. Some
// React components (e.g. anything using prefers-reduced-motion
// or prefers-color-scheme media queries) call this on mount and
// crash without it.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }),
  });
}

// Polyfill ResizeObserver which jsdom doesn't ship either.
// React components that measure their container (any modal
// with focus trap, virtualized lists) need this.
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
}
