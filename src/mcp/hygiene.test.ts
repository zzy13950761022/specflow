import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';

/**
 * Invariant #1 (the critical one): when the server runs as an MCP stdio
 * process, stdout must carry ONLY JSON-RPC frames. A stray log line on stdout
 * corrupts the protocol. We spawn the built process (dashboard disabled so no
 * port binding), send a real initialize handshake, and assert every non-empty
 * stdout line parses as JSON-RPC. All logs must appear on stderr instead.
 */

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', '..', 'dist', 'index.js');

describe('MCP stdout hygiene', () => {
  it('emits only valid JSON-RPC on stdout; logs go to stderr', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-hyg-'));

    // No --dashboard flag => pure MCP stdio mode (no port binding).
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, AI_PILOT_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    // Minimal MCP initialize request.
    const initialize =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'hygiene-test', version: '0' },
        },
      }) + '\n';
    child.stdin.write(initialize);

    // Let it respond, then terminate.
    await new Promise((r) => setTimeout(r, 800));
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    await fs.rm(home, { recursive: true, force: true });

    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);

    // There must be at least the initialize response.
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      let parsed: any;
      expect(() => (parsed = JSON.parse(line)), `stdout line not JSON: ${line}`).not.toThrow();
      expect(parsed.jsonrpc, `missing jsonrpc field: ${line}`).toBe('2.0');
    }

    // Our startup logs must have gone to stderr, proving the guard works.
    expect(stderr).toMatch(/MCP server connected over stdio|Dashboard/);
  });
});
