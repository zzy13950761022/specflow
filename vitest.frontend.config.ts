import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the dashboard frontend. The root vitest.config.ts is
 * backend-only (node env, src/**, excludes dashboard_frontend). This config
 * runs the frontend's own unit tests. Pure-logic tests (e.g. the tree builder)
 * need no DOM, so the environment stays 'node'; esbuild handles the TSX/JSX
 * transform with the automatic runtime the app uses.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    globals: true,
    include: ['dashboard_frontend/src/**/*.{test,spec}.{ts,tsx}'],
  },
});
