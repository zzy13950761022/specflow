import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dashboard_frontend/**', 'e2e/**', 'node_modules/**', 'dist/**'],
  },
});
