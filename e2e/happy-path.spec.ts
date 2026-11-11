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
  await page.getByRole('button', { name: 'or path', exact: true }).click();
  await page.getByPlaceholder('/path/to/repo').fill(repo);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(repo, { exact: false })).toBeVisible();

  // Create a spec via the UI.
  await page.getByPlaceholder('TICKET-123').fill('E2E-1');
  await page.getByPlaceholder('Feature title').fill('Checkout Tax');
  await page.getByLabel('Workflow type').selectOption('bugfix');
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

  // Open the review in the detail page; approval waits for content loading.
  await page.getByText('E2E-1').first().click();
  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  await expect(approve).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('The spec', { exact: true })).toBeVisible();
  await approve.click();
  await expect(page.getByRole('button', { name: 'Advance stage', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Advance stage', exact: true }).click();
  const specUrl = 'http://127.0.0.1:' + PORT + '/api/repos/' + repoId + '/specs/E2E-1';
  await expect.poll(async () => (await (await fetch(specUrl)).json()).currentStageId).toBe('develop');
  await expect(page.getByText('skipped', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Select SPEC', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen stage', exact: true }).click();
  await page.getByLabel('Rework reason').fill('Acceptance criteria changed');
  await page.getByRole('button', { name: 'Confirm rework', exact: true }).click();
  await expect.poll(async () => (await (await fetch(specUrl)).json()).currentStageId).toBe('spec');
  await expect(page.getByText('Outdated artifact:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Pause execution', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume execution', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume execution', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause execution', exact: true })).toBeVisible();
  await page.screenshot({ path: '/private/tmp/ai-pilot-workflow-e2e.png', fullPage: true });
});

test('inline annotations stay revision-bound through revise, reject and approve', async ({ page }) => {
  const added = await page.request.post('/api/repos', { data: { path: repo } });
  const repoId = (await added.json()).id;
  const client = await mcpClient();
  const ticketId = 'E2E-ANNOTATIONS';
  const url = '/api/repos/' + repoId + '/specs/' + ticketId;
  let submittedRevision = 1;
  async function submit(content: string) {
    const result = await client.callTool({ name: 'record_ai_output', arguments: { repoId, ticketId, stageId: 'spec', content } });
    expect(result.isError).not.toBe(true);
    submittedRevision++;
    await expect(page.getByText('Artifact revision: ' + submittedRevision, { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  }
  async function waitDecision(action: string, button: string, revision: number) {
    const request = page.waitForRequest((r) => r.url().endsWith(url + '/' + action) && r.method() === 'POST');
    await page.getByRole('button', { name: button, exact: true }).click();
    const body = (await request).postDataJSON();
    expect(body.expectedRevision).toBe(revision);
    return body;
  }
  try {
    await client.callTool({ name: 'create_spec', arguments: { repoId, ticketId, title: 'Annotation review', workflowKind: 'bugfix' } });
    await client.callTool({ name: 'record_ai_output', arguments: { repoId, ticketId, stageId: 'spec', content: '# Review\n\nInitial contract text.' } });
    await page.goto('/repos/' + repoId + '/specs/' + ticketId);
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await page.locator('.md-body p').first().evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.getByPlaceholder('Add your revision note…').fill('Use ACTIVE and INACTIVE only');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: /^Revise/ }).click();
    await expect(page.getByText('Use ACTIVE and INACTIVE only', { exact: true })).toBeVisible();
    const first = await waitDecision('needs-revision', 'Request revision', 1);
    expect(first.comment).toContain('Initial contract text.');
    expect(first.comment).toContain('Use ACTIVE and INACTIVE only');
    await expect.poll(async () => (await (await page.request.get(url)).json()).stages[0].gate.status).toBe('needs_revision');

    await submit('# Review\n\nRevised contract text.');
    await page.getByRole('button', { name: /^Revise/ }).click();
    await expect(page.getByText('Use ACTIVE and INACTIVE only', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Request revision', exact: true })).toBeDisabled();
    await page.getByPlaceholder('Overall revision comment (optional)…').fill('Explain the response mapping');
    const second = await waitDecision('needs-revision', 'Request revision', 2);
    expect(second.comment).toBe('Explain the response mapping');
    await expect.poll(async () => (await (await page.request.get(url)).json()).stages[0].gate.status).toBe('needs_revision');

    await submit('# Review\n\nThird contract text.');
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await page.getByPlaceholder('Why reject?').fill('Reconsider the mapping');
    await waitDecision('reject', 'Confirm reject', 3);
    await expect.poll(async () => (await (await page.request.get(url)).json()).stages[0].gate.status).toBe('rejected');

    await submit('# Review\n\nFinal contract text.');
    await waitDecision('approve', 'Approve', 4);
    await expect.poll(async () => (await (await page.request.get(url)).json()).stages[0].gate.approvedRevision).toBe(4);
    await page.screenshot({ path: '/private/tmp/ai-pilot-annotations-e2e.png', fullPage: true });
  } finally {
    await client.close();
  }
});


test('completed implementation is revised and approved in Dashboard before TEST', async ({ page }) => {
  const added = await page.request.post('/api/repos', { data: { path: repo } });
  const repoId = (await added.json()).id;
  const ticketId = 'E2E-IMPL';
  const url = '/api/repos/' + repoId + '/specs/' + ticketId;
  const client = await mcpClient();
  async function tool(name: string, arguments_: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: { repoId, ticketId, ...arguments_ } });
    expect(result.isError).not.toBe(true);
  }
  async function log(summary: string) {
    await tool('log_implementation', { subtaskId: 'A', summary, filesModified: ['source.ts'], filesCreated: [], statistics: { linesAdded: 1, linesRemoved: 0 }, artifacts: {} });
    await tool('set_subtask_completed', { subtaskId: 'A', completed: true });
    await tool('submit_implementation_review', {});
  }
  try {
    await tool('create_spec', { title: 'Implementation review', workflowKind: 'bugfix' });
    await tool('record_ai_output', { stageId: 'spec', content: 'Acceptance criteria' });
    await page.goto('/repos/' + repoId + '/specs/' + ticketId);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(url)).json()).stages[0].gate.status).toBe('approved');
    await tool('advance_stage', { stageId: 'spec' });
    await tool('set_develop_subtasks', { subtasks: [{ id: 'A', description: 'Implement validation' }] });
    await tool('record_ai_output', { stageId: 'develop', content: 'Implement validation plan' });
    await page.getByRole('button', { name: 'Select DEVELOP', exact: true }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(url)).json()).stages[3].gate.status).toBe('approved');
    await fs.writeFile(join(repo, 'source.ts'), 'export const validation = false;');
    await log('Initial validation implementation');
    await expect(page.getByRole('button', { name: 'Advance stage', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Read implementation report', exact: true }).click();
    await expect(page.getByText('export const validation = false;', { exact: true })).toBeVisible();
    await page.getByLabel('Implementation review comment for Implement validation').fill('Enable validation');
    await page.getByRole('button', { name: 'Revise implementation', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(url)).json()).stages[3].subtasks[0].completed).toBe(false);
    await fs.writeFile(join(repo, 'source.ts'), 'export const validation = true;');
    await log('Enabled validation');
    await page.getByRole('button', { name: 'Read implementation report', exact: true }).click();
    await expect(page.getByText('export const validation = true;', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Approve implementation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Advance stage', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Advance stage', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(url)).json()).currentStageId).toBe('test');
  } finally { await client.close(); }
});
