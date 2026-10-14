#!/usr/bin/env node
import { installStdoutGuard, logger } from './core/logger.js';
// Install the stdout guard before anything else can print (Invariant #1).
installStdoutGuard();

import { AppCore } from './core/app-core.js';
import { startMcpServer } from './mcp/server.js';
import { startDashboard } from './dashboard/server.js';
import { FileWatcher } from './core/file-watcher.js';

const DEFAULT_PORT = 4123;

function parseArgs(argv: string[]): { dashboard: boolean; port: number } {
  const dashboard = argv.includes('--dashboard');
  let port = DEFAULT_PORT;
  const i = argv.indexOf('--port');
  if (i >= 0 && argv[i + 1]) port = Number(argv[i + 1]);
  const eq = argv.find((a) => a.startsWith('--port='));
  if (eq) port = Number(eq.split('=')[1]);
  return { dashboard, port };
}

async function main(): Promise<void> {
  const { dashboard, port } = parseArgs(process.argv.slice(2));
  const app = new AppCore();

  if (dashboard) {
    // Dashboard-only mode: HTTP + WS + file watching, no MCP stdio.
    const { url } = await startDashboard(app, { port });
    const watcher = new FileWatcher(app);
    await watcher.start();
    logger.info(`Dashboard ready at ${url}`);
  } else {
    // MCP mode: stdio only. The dashboard runs as a separate process.
    await startMcpServer(app);
  }
}

main().catch((err) => {
  logger.error('Fatal:', String(err));
  process.exit(1);
});
