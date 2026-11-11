import { test, expect, type Page } from '@playwright/test';
import { StageMachine } from '../src/core/stage-machine';
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

  // Create a spec via the accessible dialog.
  await page.getByRole('button', { name: 'Create Spec', exact: true }).click();
  await page.getByPlaceholder('TICKET-123').fill('E2E-1');
  await page.getByPlaceholder('Feature title').fill('Checkout Tax');
  await page.getByLabel('Workflow type').selectOption('bugfix');
  await page.getByRole('dialog', { name: 'Create Spec' }).getByRole('button', { name: 'Create Spec', exact: true }).click();
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
  await expect(page).toHaveURL(/repos\/.*\/specs\/E2E-1/);
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

async function mockDashboard(page: Page) {
  const machine = new StageMachine();
  const specs = [
    machine.createSpec({ ticketId: 'UI-2', title: 'Repair checkout', workflowKind: 'bugfix' }),
    machine.createSpec({ ticketId: 'UI-10', title: 'Document billing', workflowKind: 'documentation' }),
  ];
  specs[0].updatedAt = '2026-11-01T00:00:00Z';
  specs[1].updatedAt = '2026-11-02T00:00:00Z';
  let settings = { revision: 3, profiles: [{ id: 'codex-local', name: 'Local Codex', agent: 'codex', version: 1, model: '', provider: '', baseUrl: '', credentialEnv: '', command: '', configPath: '' }], defaultProfileId: 'codex-local', repoDefaults: { 'ui-repo': 'codex-local' } };
  const state = { detections: [] as Record<string, unknown>[], existingProfile: false, noDefault: false, detectError: false, resumeBodies: [] as Record<string, unknown>[], createFails: false, saveFails: false, startFails: false, transfers: 0, resumes: 0, creations: [] as Record<string, unknown>[], saved: null as unknown, mode: 'dashboard' };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.method() === 'GET' ? undefined : request.postDataJSON();
    const reply = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (state.existingProfile) {
      specs[0].automation = { enabled: false, status: 'paused', attempt: 0, mode: 'ide', profile: { id: 'codex-local', name: 'Original Codex', agent: 'codex', version: 1, model: 'original-model' } };
      settings.profiles[0] = { ...settings.profiles[0], name: 'Changed saved Codex', version: 2, model: 'changed-model' };
    }
    if (path === '/api/review-session') return reply({ token: 'ui-review-token' });
    if (path.startsWith('/api/agents/') || path.endsWith('/handoff') || request.method() !== 'GET') expect(request.headers()['x-specflow-review-session']).toBe('ui-review-token');
    if (path === '/api/repos') return reply([{ id: 'ui-repo', name: 'UI repository', path: '/tmp/ui-repo', addedAt: '2026-01-01' }]);
    if (path === '/api/automation') return reply({ available: true });
    if (path === '/api/agents/settings') {
      if (request.method() === 'PUT') {
        state.saved = body;
        if (state.saveFails) return reply({ error: 'Settings changed elsewhere. Reopen settings and try again.' }, 409);
        settings = { ...body, revision: body.revision + 1 };
      }
      return reply(state.noDefault ? { ...settings, defaultProfileId: undefined, repoDefaults: {}, profiles: [...settings.profiles, { id: 'claude-explicit', name: 'Explicit Claude', agent: 'claude', version: 1 }] } : settings);
    }
    if (path === '/api/agents/detect') { state.detections.push(body); return reply({ command: '/tmp/working-' + body.agent, installations: [{command: '/tmp/working-' + body.agent, label: 'VS Code extension', version: '1.2.3'}], models: [{id: 'detected-model', label: 'Current model', provider: 'hyperspace'}, {id: body.agent === 'opencode' ? 'other-provider/other-model' : 'other-model', label: 'Other model', provider: 'other-provider'}], error: state.detectError ? 'Cannot read agent configuration' : undefined, available: true, version: '1.2.3', configPath: '/tmp/agent-config', model: 'detected-model', provider: 'hyperspace', credentialEnv: 'HYPERSPACE_API_KEY' }); }
    if (path === '/api/agents/test') return reply({ ok: false, checks: [{ name: 'Credentials', status: 'failed', message: 'HYPERSPACE_API_KEY is not set' }] });
    if (path.endsWith('/handoff')) {
      if (request.method() === 'POST') { state.transfers++; state.mode = 'ide'; }
      return reply({ context: 'Resume UI-2 in /tmp/ui-repo. Human approval is required before TEST.', workspacePath: '/tmp/ui-repo', mode: state.mode, canHandoff: state.mode === 'dashboard' });
    }
    if (path.endsWith('/automation/resume')) { state.resumeBodies.push(body); state.resumes++; state.mode = 'dashboard'; return reply(specs[0]); }
    if (path.endsWith('/execution')) return reply({ status: 'ready', actions: [] });
    if (path.endsWith('/artifact')) return reply({ error: 'No artifact' }, 404);
    if (path === '/api/repos/ui-repo/specs') {
      if (request.method() === 'POST') {
        state.creations.push(body);
        if (state.createFails) return reply({ error: 'Could not persist spec' }, 500);
        const spec = machine.createSpec(body);
        if (state.startFails) spec.automation = { enabled: true, status: 'failed', attempt: 1, error: 'Agent failed to start. Retry from this spec.' };
        specs.push(spec);
        return reply(spec);
      }
      return reply(specs);
    }
    const match = path.match(new RegExp('/specs/([^/]+)$'));
    if (match) return reply(specs.find((spec) => spec.ticketId === match[1]));
    return reply({ error: 'Unexpected fixture request: ' + path }, 404);
  });
  return state;
}

test('board filters survive detail navigation and distinguish no matches', async ({ page }) => {
  await mockDashboard(page);
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('2 of 2 specs');
  await page.getByLabel('Search specs').fill('CHECKOUT');
  await page.getByLabel('Filter workflow').selectOption('bugfix');
  await page.getByLabel('Filter stage').selectOption('spec');
  await page.getByLabel('Sort specs').selectOption('ticket');
  await expect(page.getByRole('status')).toHaveText('1 of 2 specs');
  await page.getByRole('link', { name: /UI-2/ }).click();
  await page.getByRole('button', { name: 'Select DEVELOP', exact: true }).click();
  await page.getByRole('link', { name: '← Board', exact: true }).click();
  await expect(page.getByLabel('Search specs')).toHaveValue('CHECKOUT');
  await expect(page.getByLabel('Filter workflow')).toHaveValue('bugfix');
  await expect(page.getByLabel('Filter stage')).toHaveValue('spec');
  await expect(page.getByLabel('Sort specs')).toHaveValue('ticket');
  await page.getByLabel('Search specs').fill('not found');
  await expect(page.getByText('No specs match your filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('status')).toHaveText('2 of 2 specs');
});

test('create dialog retains failed form, traps focus, and shows start failure on persisted detail', async ({ page }) => {
  const state = await mockDashboard(page);
  state.createFails = true;
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Create Spec', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Create Spec' });
  await expect(dialog.getByLabel('Ticket ID')).toBeFocused();
  await dialog.getByRole('button', { name: 'Close dialog' }).focus();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByLabel('Ticket ID').fill('UI-NEW');
  await dialog.getByLabel('Title', { exact: true }).fill('Create robust flow');
  await dialog.getByLabel('Description').fill('Keep the acceptance criteria after errors.');
  await dialog.getByLabel('Execution', { exact: true }).selectOption('dashboard');
  await expect(dialog.getByLabel('Execution configuration')).toHaveValue('codex-local');
  await dialog.getByRole('button', { name: 'Create & Start' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Could not persist spec');
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByLabel('Description')).toHaveValue('Keep the acceptance criteria after errors.');
  await page.screenshot({ path: '/private/tmp/ai-pilot-create-dialog.png' });
  state.createFails = false; state.startFails = true;
  await dialog.getByRole('button', { name: 'Create & Start' }).click();
  await expect(page).toHaveURL(new RegExp('/specs/UI-NEW'));
  await expect(page.getByText('Agent failed to start. Retry from this spec.')).toBeVisible();
  expect(state.creations).toHaveLength(2);
  expect(state.creations[1]).toMatchObject({ autoRun: true, agentProfileId: 'codex-local', description: 'Keep the acceptance criteria after errors.' });
});

test('agent settings detects configuration and retains edits after revision conflict', async ({ page }) => {
  const state = await mockDashboard(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Agent settings' });
  await dialog.getByRole('button', { name: 'Add configuration', exact: true }).click();
  await dialog.getByText('Advanced settings', { exact: true }).click();
  await dialog.getByLabel('Configuration name').fill('Hyperspace Claude');
  await dialog.getByLabel('Agent', { exact: true }).selectOption('claude');
  await expect(dialog.getByText('Current: detected-model', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Credential environment variable')).toHaveValue('');
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByText(/Credentials: failed/)).toBeVisible();
  await dialog.getByLabel('User default').selectOption({ label: 'Hyperspace Claude · Claude Code · Local current model' });
  await dialog.getByLabel(/Repository default/).selectOption({ label: 'Hyperspace Claude · Claude Code · Local current model' });
  state.saveFails = true;
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Settings changed elsewhere');
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByLabel('Configuration name')).toHaveValue('Hyperspace Claude');
  expect(state.saved).toMatchObject({ revision: 3 });
  state.saveFails = false;
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog.getByText('Settings saved.')).toBeVisible();
  await page.screenshot({ path: '/private/tmp/ai-pilot-agent-settings.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Agent settings', exact: true })).toBeFocused();
});

test('copy context is read-only and IDE transfer is explicit with a clipboard fallback', async ({ page }) => {
  const state = await mockDashboard(page);
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Unavailable')) } }));
  await page.goto('/repos/ui-repo/specs/UI-2');
  await page.getByRole('button', { name: 'Copy context', exact: true }).click();
  await expect(page.getByLabel('IDE context')).toHaveValue(/Resume UI-2/);
  expect(state.transfers).toBe(0);
  await page.getByRole('button', { name: 'Continue in IDE', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open workspace in VS Code' })).toHaveAttribute('href', 'vscode://file/tmp/ui-repo');
  expect(state.transfers).toBe(1);
  await page.getByRole('button', { name: 'Resume in Dashboard', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue in IDE', exact: true })).toBeVisible();
  expect(state.resumes).toBe(1);
});


test('manual IDE ticket without defaults resumes with the explicitly selected profile', async ({ page }) => {
  const state = await mockDashboard(page);
  state.noDefault = true;
  state.mode = 'ide';
  await page.goto('/repos/ui-repo/specs/UI-2');
  await page.getByLabel('Execution configuration').selectOption('claude-explicit');
  await page.getByRole('button', { name: 'Select DEVELOP', exact: true }).click();
  await page.getByRole('button', { name: 'Resume in Dashboard', exact: true }).click();
  await expect.poll(() => state.resumeBodies).toEqual([{ profileId: 'claude-explicit' }]);
});

test('agent detection surfaces config read errors without applying partial configuration', async ({ page }) => {
  const state = await mockDashboard(page);
  state.detectError = true;
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(dialog.getByRole('alert')).toHaveText('Cannot read agent configuration');
  await dialog.getByText('Advanced settings', { exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Config path')).toHaveValue('');
  await expect(dialog.getByText(/Local configuration detected/)).toHaveCount(0);
});


test('agent settings scroll body keeps every field above the fixed footer', async ({ page }) => {
  await mockDashboard(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Agent settings' });
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await dialog.getByText('Advanced settings', { exact: true }).click();
  const bounds = await dialog.evaluate((element) => {
    const form = element.querySelector('form')!;
    const body = form.firstElementChild as HTMLElement;
    const footer = form.lastElementChild as HTMLElement;
    const box = (item: Element) => { const bounds = item.getBoundingClientRect(); return { top: bounds.top, bottom: bounds.bottom, height: bounds.height }; };
    return { dialog: box(element), body: box(body), footer: box(footer), bodyScrollHeight: body.scrollHeight, bodyClientHeight: body.clientHeight };
  });
  console.log('Agent settings layout:', JSON.stringify(bounds));
  expect(bounds.footer.top).toBeGreaterThanOrEqual(bounds.body.bottom - 1);
  expect(bounds.footer.bottom).toBeLessThanOrEqual(bounds.dialog.bottom);
  expect(bounds.footer.bottom).toBeGreaterThanOrEqual(bounds.dialog.bottom - 2);
  expect(bounds.bodyScrollHeight).toBeGreaterThan(bounds.bodyClientHeight);
  await dialog.getByLabel('Config path').scrollIntoViewIfNeeded();
  await dialog.getByLabel('Config path').fill('/tmp/reachable-config');
  await dialog.getByRole('button', { name: 'Test connection' }).scrollIntoViewIfNeeded();
  const buttonBox = (await dialog.getByRole('button', { name: 'Test connection' }).boundingBox())!;
  const footerBox = await dialog.locator('form > :last-child').boundingBox();
  expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(footerBox!.y);
  expect(footerBox!.y).toBe(bounds.footer.top);
  await page.screenshot({ path: '/private/tmp/ai-pilot-agent-settings-scrolled.png' });
  await dialog.getByLabel('User default').scrollIntoViewIfNeeded();
  const defaultBox = (await dialog.getByLabel('User default').boundingBox())!;
  expect(defaultBox.y).toBeGreaterThanOrEqual(bounds.body.top);
  await page.screenshot({ path: '/private/tmp/ai-pilot-agent-settings.png' });
});


test('existing IDE ticket preserves its profile snapshot unless another profile is explicitly selected', async ({ page }) => {
  const state = await mockDashboard(page);
  state.existingProfile = true;
  state.mode = 'ide';
  await page.goto('/repos/ui-repo/specs/UI-2');
  await expect(page.getByLabel('Execution configuration')).toHaveValue('');
  await expect(page.getByRole('option', { name: 'Keep current configuration · Original Codex v1', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Resume in Dashboard', exact: true }).click();
  await expect.poll(() => state.resumeBodies).toEqual([{}]);
  state.mode = 'ide';
  await page.reload();
  await page.getByLabel('Execution configuration').selectOption('codex-local');
  await page.getByRole('button', { name: 'Resume in Dashboard', exact: true }).click();
  await expect.poll(() => state.resumeBodies).toEqual([{}, { profileId: 'codex-local' }]);
});


test('configuration setup detects automatically and hides optional names and provider identifiers', async ({ page }) => {
  const state = await mockDashboard(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Agent settings' });
  await dialog.getByRole('button', { name: 'Add configuration', exact: true }).click();
  await expect(dialog.getByLabel('Configuration name', { exact: true })).not.toBeVisible();
  await expect(dialog.getByLabel('Provider', { exact: true })).not.toBeVisible();
  await expect(dialog.getByText('Current: detected-model', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Installation', { exact: true })).toHaveValue('/tmp/working-codex');
  await dialog.getByLabel('Agent', { exact: true }).selectOption('opencode');
  await expect.poll(() => state.detections.some((body) => body.agent === 'opencode' && !body.command)).toBe(true);
  await expect(dialog.getByLabel('Installation', { exact: true })).toHaveValue('/tmp/working-opencode');
  await dialog.getByLabel('Search models').fill('Other');
  await dialog.getByLabel('Model', { exact: true }).selectOption({ label: 'Other model · other-provider' });
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog.getByText('Settings saved.')).toBeVisible();
  const added = (state.saved as any).profiles.at(-1);
  expect(added).toMatchObject({ name: 'OpenCode', agent: 'opencode', model: 'other-provider/other-model', provider: 'other-provider', command: '/tmp/working-opencode' });
  expect(added.baseUrl).toBeUndefined();
  expect(added.credentialEnv).toBeUndefined();
  await expect(dialog.getByText('Current: detected-model', { exact: true })).toBeVisible();
  await dialog.locator('.dialog-body').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: '/private/tmp/ai-pilot-settings-simple.png' });
  await dialog.getByText('Advanced settings', { exact: true }).click();
  await dialog.getByLabel('Model', { exact: true }).selectOption('custom');
  await dialog.getByLabel('Custom model ID', { exact: true }).fill('new-provider/custom');
  await expect(dialog.getByLabel('Provider', { exact: true })).toHaveValue('new-provider');
  await dialog.getByLabel('Configuration name', { exact: true }).fill('My daily work');
  await dialog.getByLabel('Agent', { exact: true }).selectOption('claude');
  await expect(dialog.getByLabel('Configuration name', { exact: true })).toHaveValue('My daily work');
  await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Provider', { exact: true })).toHaveValue('');
});


test('late native detection cannot overwrite a different Agent selection', async ({ page }) => {
  await mockDashboard(page);
  let release!: () => void;
  let started = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/agents/detect', async (route) => {
    const agent = route.request().postDataJSON().agent;
    if (agent === 'codex') { started = true; await pending; }
    await route.fulfill({ json: { available: true, command: '/tmp/' + agent, model: agent + '-current', models: [], installations: [{command: '/tmp/' + agent, label: agent, version: '1'}] } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Agent settings' });
  await expect.poll(() => started).toBe(true);
  await dialog.getByLabel('Agent', { exact: true }).selectOption('claude');
  await expect(dialog.getByText('Current: claude-current', { exact: true })).toBeVisible();
  const oldResponse = page.waitForResponse((response) => response.url().endsWith('/api/agents/detect') && response.request().postDataJSON().agent === 'codex');
  release();
  await oldResponse;
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(dialog.getByText('Current: claude-current', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Installation', { exact: true })).toHaveValue('/tmp/claude');
});
