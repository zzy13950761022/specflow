import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4188',
    trace: 'on-first-retry',
  },
  // The webServer is started by the test itself (needs a temp AI_PILOT_HOME),
  // so no global webServer block here.
});
