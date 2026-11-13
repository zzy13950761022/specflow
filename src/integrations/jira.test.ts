import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { JiraIntegration } from './jira.js';
let root: string;
let jira: JiraIntegration;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'jira-import-'));
  const config = join(root, 'jira-mcp.json');
  await fs.writeFile(config, JSON.stringify({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/jira-server.mjs', import.meta.url))], env: { JIRA_AUDIT: join(root, 'calls') } }));
  jira = new JiraIntegration(config, 1500);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('reports a missing connection without starting a process', async () => {
  expect(await new JiraIntegration(join(root, 'missing')).status()).toEqual({ configured: false });
});
it('imports only the matching issue through the read tool and omits private metadata', async () => {
  expect(await jira.issue(' test-12 ')).toEqual({ key: 'TEST-12', summary: 'Shipping validation', description: 'Given an order\nThen calculate shipping' });
  expect(await fs.readFile(join(root, 'calls'), 'utf8')).toBe('get_issue\n');
});
it('rejects invalid keys before launching the MCP', async () => {
  await expect(jira.issue('../etc/passwd')).rejects.toThrow(/Ticket ID/);
  await expect(fs.stat(join(root, 'calls'))).rejects.toThrow();
});
it('does not attach another ticket to the request', async () => {
  await expect(jira.issue('WRONG-1')).rejects.toThrow(/different ticket/);
});
it('returns actionable auth errors without forwarding raw credentials or server text', async () => {
  await expect(jira.issue('AUTH-1')).rejects.toThrow('Jira authentication failed (401). Update the Jira MCP credentials and retry.');
});
it('bounds slow lookups and closes the process', async () => {
  await expect(jira.issue('WAIT-1')).rejects.toThrow(/timed out/);
});
