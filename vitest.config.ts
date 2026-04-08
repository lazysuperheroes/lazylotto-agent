// Vitest config for the React frontend test suite.
//
// Two test runners coexist in this repo:
//
//   1. node --test runs the existing CLI/agent/custodial test
//      suite (~380 tests under src/). These run in pure Node and
//      don't need a DOM. Triggered by `npm test`.
//
//   2. vitest (this config) runs React component tests under
//      app/ using @testing-library/react inside jsdom. Triggered
//      by `npm run test:web`.
//
// Keeping them separate avoids two problems:
//   - vitest's transform pipeline interferes with tsx's import
//     hook for the Node tests
//   - React tests need jsdom + React-specific globals that would
//     slow down the agent test run if shared
//
// The two suites do NOT share fixtures or helpers — frontend
// tests stub out API responses and don't touch the custodial
// layer.

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Only pick up React component tests under app/, not the
    // node:test files under src/. Suffix is .test.tsx to make
    // the boundary obvious at a glance.
    include: ['app/**/*.test.tsx', 'app/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', '.next/**'],
  },
  resolve: {
    alias: {
      // Match the same '~/' path alias used by tsconfig.json so
      // imports work in tests too.
      '~': path.resolve(__dirname, './src'),
    },
  },
});
