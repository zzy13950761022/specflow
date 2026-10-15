import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const port = process.env.VITE_DASHBOARD_PORT || '4123';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: dirname(fileURLToPath(new URL(import.meta.url))),
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: `http://localhost:${port}`, changeOrigin: true },
      '/ws': { target: `ws://localhost:${port}`, ws: true },
    },
  },
});
