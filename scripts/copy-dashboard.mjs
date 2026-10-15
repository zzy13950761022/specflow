#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'dashboard_frontend', 'dist');
const dest = join(root, 'dist', 'dashboard', 'public');

if (!existsSync(src)) {
  console.error('Frontend build not found at', src, '— run vite build first.');
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.error('Copied dashboard SPA to', dest);
