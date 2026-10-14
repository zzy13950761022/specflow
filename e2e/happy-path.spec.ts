import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');
const PORT = 4188;

let server: ChildProcess;
let home: string;
let repo: string;

test.beforeAll(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-e2e-home-'));
  repo = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-e2e-repo-'));
  server = spawn(process.execPath, [entry, '--dashboard', '--port', String(PORT)], {
    env: { ...process.env, AI_PILOT_HOME: home },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(async () => {
  server?.kill('SIGTERM');
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(repo, { recursive: true, force: true });
});

/**
 * A second process in MCP (stdio) mode acts as "Claude": it shares the same
 * AI_PILOT_HOME + repo files, so a record_ai_output there surfaces on the
 * dashboard live. This exercises both transports against one on-disk state.
 */
async function mcpClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, AI_PILOT_HOME: home },
  });
  const client = new Client({ name: 'e2e-claude', version: '0' });
  await client.connect(transport);
  return client;
}

test('happy path: add repo, create spec, Claude records output, human approves, advances', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AI Pilot' })).toBeVisible();

  // Add a repo by path. The native Finder picker can't be automated, so use
  // the manual-entry fallback (toggle it open first).
  await page.getByRole('button', { name: 'or enter a path manually' }).click();
  await page.getByPlaceholder('/path/to/repo').fill(repo);
  await page.getByRole('button', { name: 'Add by path' }).click();
  await expect(page.getByText(repo, { exact: false })).toBeVisible();

  // Create a spec via the UI.
  await page.getByPlaceholder('TICKET-123').fill('E2E-1');
  await page.getByPlaceholder('Feature title').fill('Checkout Tax');
  await page.getByRole('button', { name: 'Create spec' }).click();
  await expect(page.getByText('E2E-1').first()).toBeVisible();

  // "Claude" records the stage-0 output over MCP; the board must update live.
  const repos = await (await fetch(`http://127.0.0.1:${PORT}/api/repos`)).json();
  const repoId = repos[0].id;
  const claude = await mcpClient();
  try {
    await claude.callTool({
      name: 'record_ai_output',
      arguments: { repoId, ticketId: 'E2E-1', stageId: 'spec', content: '# The spec' },
    });
  } finally {
    await claude.close();
  }

  // The Approve button appears once the gate is pending_review (live via WS).
  const approve = page.getByRole('button', { name: 'Approve' }).first();
  await expect(approve).toBeVisible({ timeout: 10000 });

  // Human approves in the dashboard.
  await approve.click();

  // Once SPEC's gate is approved, the card advances to the REQUIREMENTS lane
  // (the board places a spec in its first non-approved stage), whose gate is
  // not_ready — so no Approve button remains visible for this card.
  await expect(page.getByText('E2E-1').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0, { timeout: 10000 });
});
