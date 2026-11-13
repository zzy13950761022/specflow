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

async function sap(fail = false) {
  const connection = { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/sap-server.mjs', import.meta.url))], env: { SAP_AUDIT: join(root, 'sap-calls'), SAP_COOKIE: join(root, 'cookies'), ...(fail ? { SAP_FAIL: '1' } : {}) } };
  const config = join(root, 'sap.json');
  await fs.writeFile(config, JSON.stringify({ ...connection, auth: { ...connection, entryUrl: 'https://jira.tools.sap/', storePath: join(root, 'trusted-cookies') } }));
  return new JiraIntegration(config, 1500, 1500);
}
it('reads the SAP snake-case tool and strips private formatted metadata and comments', async () => {
  const official = await sap();
  expect(await official.status()).toEqual({ configured: true, authenticationAvailable: true });
  expect(await official.issue('SAP-1')).toEqual({ key: 'SAP-1', summary: 'Shipping validation', description: 'Given an order\nThen calculate shipping' });
  const calls = (await fs.readFile(join(root, 'sap-calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls).toEqual([{ name: 'get_issue', args: { issue_key: 'SAP-1', fields: 'summary,description' } }]);
  await expect(official.issue('WRONG-1')).rejects.toThrow(/different ticket/);
  await expect(official.issue('BAD-1')).rejects.toThrow(/unsupported issue response/);
});
it('requires explicit SAP sign-in, coalesces login and uses trusted host parameters before retry', async () => {
  const official = await sap();
  await expect(official.issue('SSO-1')).rejects.toMatchObject({ code: 'SAP_AUTH_REQUIRED' });
  expect((await fs.readFile(join(root, 'sap-calls'), 'utf8')).trim().split('\n')).toHaveLength(1);
  expect(await Promise.all([official.authenticate(), official.authenticate()])).toEqual([{ authenticated: true }, { authenticated: true }]);
  expect((await official.issue('SSO-1')).key).toBe('SSO-1');
  const calls = (await fs.readFile(join(root, 'sap-calls'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls.filter(call => call.name === 'sap_authenticate')).toEqual([{ name: 'sap_authenticate', args: { entry_url: 'https://jira.tools.sap/', store_path: join(root, 'trusted-cookies') } }]);
});
it('normalizes nested Jira fields and empty descriptions', async () => {
  expect(await (await sap()).issue('JSON-1')).toEqual({ key: 'JSON-1', summary: 'Shipping validation', description: '' });
});
it('does not mistake a failed auth tool response for successful login or leak cookies', async () => {
  const official = await sap(true);
  await expect(official.authenticate()).rejects.toThrow('SAP SSO sign-in did not complete. Retry and complete login in the browser on the Dashboard host.');
});
