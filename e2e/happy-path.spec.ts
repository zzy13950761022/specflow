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

test('happy path: add repo, MCP creates spec, human approves, advances', async ({
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

  // Manual IDE workflows enter through MCP; Dashboard creation now always starts an Agent.
  const repos = await (await fetch(`http://127.0.0.1:${PORT}/api/repos`)).json();
  const repoId = repos[0].id;
  const claude = await mcpClient();
  try {
    const created = await claude.callTool({ name: 'create_spec', arguments: { repoId, ticketId: 'E2E-1', title: 'Checkout Tax', workflowKind: 'bugfix' } });
    expect(created.isError).not.toBe(true);
    await page.getByRole('link', { name: /E2E-1/ }).click();
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
  for (const label of ['REQUIREMENTS', 'DESIGN']) await expect(page.getByRole('button', { name: 'Select ' + label, exact: true })).toHaveAttribute('title', /skipped/);
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
    await expect(page.getByText('Revision ' + submittedRevision, { exact: true })).toBeVisible();
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
    await expect(page.getByText('export const validation = false;', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Revise implementation', exact: true }).click();
    await page.getByLabel('Implementation review comment', { exact: true }).fill('Enable validation');
    await page.getByRole('button', { name: 'Confirm revision', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(url)).json()).stages[3].subtasks[0].completed).toBe(false);
    await fs.writeFile(join(repo, 'source.ts'), 'export const validation = true;');
    await log('Enabled validation');
    await expect(page.getByText('export const validation = true;', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Approve & next', exact: true }).click();
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
  let settings = { revision: 3, profiles: [{ id: 'repo-only', name: 'Old repository config', agent: 'claude', version: 1, model: '', provider: '', baseUrl: '', credentialEnv: '', command: '', configPath: '' }, { id: 'codex-local', name: 'Local Codex', agent: 'codex', version: 1, model: '', provider: '', baseUrl: '', credentialEnv: '', command: '', configPath: '' }], defaultProfileId: 'codex-local', repoDefaults: { 'ui-repo': 'repo-only' } };
  const state = { noProfiles: false, reviewable: false, detections: [] as Record<string, unknown>[], existingProfile: false, noDefault: false, detectError: false, resumeBodies: [] as Record<string, unknown>[], createFails: false, saveFails: false, startFails: false, transfers: 0, resumes: 0, creations: [] as Record<string, unknown>[], saved: null as unknown, mode: 'dashboard' };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.method() === 'GET' ? undefined : request.postDataJSON();
    const reply = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (state.reviewable) {
      specs[0].stages[0].aiStatus = 'done';
      specs[0].stages[0].gate.status = 'pending_review';
      specs[0].stages[0].revision = 1;
      specs[0].stages[0].artifact = {kind: 'markdown', path: 'spec.md'};
      specs[0].execution.status = 'waiting_review';
      specs[0].description = 'Detailed feature requirements.';
      specs[0].automation = {enabled: true, status: 'waiting_review', attempt: 1, mode: 'dashboard', threadId: 'layout-session', worktreePath: '/tmp/ui-repo/worktree', profile: {id: 'codex-local', name: 'Codex', agent: 'codex', version: 1}};
    }
    if (state.existingProfile) {
      specs[0].automation = { enabled: false, status: 'paused', attempt: 0, mode: 'ide', profile: { id: 'codex-local', name: 'Original Codex', agent: 'codex', version: 1, model: 'original-model' } };
      settings.profiles[1] = { ...settings.profiles[1], name: 'Changed saved Codex', version: 2, model: 'changed-model' };
    }
    if (path === '/api/review-session') return reply({ token: 'ui-review-token' });
    if (path.startsWith('/api/agents/') || path.endsWith('/handoff') || request.method() !== 'GET') expect(request.headers()['x-specflow-review-session']).toBe('ui-review-token');
    if (path === '/api/repos') return reply([{ id: 'ui-repo', name: 'UI repository', path: '/tmp/ui-repo', addedAt: '2026-01-01' }]);
    if (path === '/api/automation') return reply({ available: true });
    if (path === '/api/integrations/jira') return reply({ configured: false });
    if (path === '/api/agents/settings') {
      if (request.method() === 'PUT') {
        state.saved = body;
        if (state.saveFails) return reply({ error: 'Settings changed elsewhere. Reopen settings and try again.' }, 409);
        settings = { ...body, revision: body.revision + 1 };
      }
      if (state.noProfiles) return reply({ revision: settings.revision, profiles: [] });
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
    if (state.reviewable && path.endsWith('/artifact')) return reply({artifact: specs[0].stages[0].artifact, revision: 1, content: '# Shipping specification\n\n' + Array.from({length: 40}, (_, i) => '## Requirement ' + (i + 1) + '\n\nCalculate shipping in integer cents. Preserve member and regular order thresholds.\n\n').join('')});
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
  await dialog.getByLabel('Description').fill('Keep the acceptance criteria after errors.');
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


test('only User default selects configuration in settings, creation and manual execution', async ({ page }) => {
  await mockDashboard(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(settings.getByLabel('User default')).toBeVisible();
  await expect(settings.getByLabel(/Repository default/)).toHaveCount(0);
  await expect(settings.getByLabel('Edit configuration')).toHaveValue('codex-local');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Create Spec', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create Spec' });
  await expect(create.getByLabel('Execution configuration')).toHaveValue('codex-local');
  await create.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('link', { name: /UI-2/ }).click();
  await expect(page.getByLabel('Execution configuration')).toHaveValue('codex-local');
});


test('ticket detail gives the artifact most of the viewport and handoff does not cover scrolling text', async ({ page }) => {
  await page.setViewportSize({width: 1280, height: 720});
  const state = await mockDashboard(page);
  state.reviewable = true;
  await page.goto('/repos/ui-repo/specs/UI-2');
  const heading = page.getByRole('heading', {name: 'Shipping specification', exact: true});
  await expect(heading).toBeVisible();
  const box = await heading.boundingBox();
  expect(box!.y).toBeLessThan(720 * 0.45);
  await expect(page.getByText('Agent session: layout-session', {exact: true})).not.toBeVisible();
  await expect(page.getByRole('button', {name: 'Approve', exact: true})).toBeVisible();
  const content = page.getByRole('region', {name: 'Stage content', exact: true});
  expect((await content.boundingBox())!.height).toBeGreaterThan(720 * 0.55);
  await page.screenshot({path: '/private/tmp/ai-pilot-detail-compact.png'});
  await content.evaluate((element) => { element.scrollTop = 500; });
  await expect(page.getByRole('button', {name: 'Copy context', exact: true})).not.toBeInViewport();
  await expect(page.getByRole('button', {name: 'Approve', exact: true})).toBeInViewport();
  await page.getByRole('button', {name: 'Execution details', exact: true}).click();
  await expect(page.getByText('Agent session: layout-session', {exact: true})).toBeVisible();
  await expect(page.getByText('Configuration: Codex · Local current model', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Execution details', exact: true}).click();
  await page.getByRole('button', {name: 'Select DESIGN', exact: true}).click();
  await expect(page).toHaveURL(/stage=design/);
  expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
  await page.setViewportSize({width: 768, height: 720});
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(768);
});


test('Create Spec only asks for ticket requirements and starts Dashboard with normal risk', async ({ page }) => {
  const state = await mockDashboard(page);
  await page.goto('/');
  await page.getByRole('button', {name: 'Create Spec', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Create Spec'});
  await expect(dialog.getByLabel('Execution configuration')).toHaveValue('codex-local');
  await expect(dialog.getByLabel('Repository', {exact: true})).toHaveCount(0);
  await expect(dialog.getByLabel('Title', {exact: true})).toHaveCount(0);
  await expect(dialog.getByLabel('Change risk', {exact: true})).toHaveCount(0);
  await expect(dialog.getByLabel('Execution', {exact: true})).toHaveCount(0);
  await dialog.getByLabel('Ticket ID').fill('SIMPLE-1');
  await expect(dialog.getByRole('button', {name: 'Create & Start', exact: true})).toBeDisabled();
  await dialog.getByLabel('Description').fill('# Calculate shipping\n\nAmounts are integer cents.');
  await page.screenshot({path: '/private/tmp/ai-pilot-create-simple.png'});
  await dialog.getByRole('button', {name: 'Create & Start', exact: true}).click();
  await expect.poll(() => state.creations.length).toBe(1);
  expect(state.creations[0]).toMatchObject({ticketId: 'SIMPLE-1', title: 'Calculate shipping', description: '# Calculate shipping\n\nAmounts are integer cents.', risk: 'normal', autoRun: true, autoChecks: false, agentProfileId: 'codex-local'});
  await expect(page).toHaveURL(/repos\/ui-repo\/specs\/SIMPLE-1/);
});

test('Create Spec requires an execution configuration instead of silently creating an IDE ticket', async ({ page }) => {
  const state = await mockDashboard(page);
  state.noProfiles = true;
  await page.goto('/');
  await page.getByRole('button', {name: 'Create Spec', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Create Spec'});
  await dialog.getByLabel('Ticket ID').fill('SIMPLE-2');
  await dialog.getByLabel('Description').fill('Calculate shipping');
  await expect(dialog.getByRole('button', {name: 'Create & Start', exact: true})).toBeDisabled();
  await expect(dialog.getByText(/Add configurations in Agent settings/)).toBeVisible();
  expect(state.creations).toHaveLength(0);
});

for (const verdict of ['approved', 'needs_revision', 'rejected'] as const) {
  test('reviews all implementation reports with one ' + verdict + ' decision', async ({ page }) => {
    const added = await page.request.post('/api/repos', { data: { path: repo } });
    const repoId = (await added.json()).id;
    const ticketId = 'E2E-BULK-' + verdict;
    const url = '/api/repos/' + repoId + '/specs/' + ticketId;
    const client = await mcpClient();
    async function tool(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: { repoId, ticketId, ...args } });
      expect(result.isError).not.toBe(true);
    }
    const state = async () => (await page.request.get(url)).json();
    try {
      await tool('create_spec', { title: 'Bulk implementation review', workflowKind: 'bugfix' });
      await tool('record_ai_output', { stageId: 'spec', content: 'Requirements' });
      await page.goto(url.replace('/api', ''));
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect.poll(async () => (await state()).stages[0].gate.status).toBe('approved');
      await tool('advance_stage', { stageId: 'spec' });
      await tool('set_develop_subtasks', { subtasks: [{ id: 'A', description: 'Implement validation' }, { id: 'B', description: 'Test validation', dependsOn: ['A'] }] });
      await tool('record_ai_output', { stageId: 'develop', content: 'Development plan' });
      await page.getByRole('button', { name: 'Select DEVELOP', exact: true }).click();
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect.poll(async () => (await state()).stages[3].gate.status).toBe('approved');
      for (const id of ['A', 'B']) {
        await tool('log_implementation', { subtaskId: id, summary: 'Completed task ' + id, filesModified: ['source.ts'], filesCreated: [], statistics: { linesAdded: 1, linesRemoved: 0 }, artifacts: {} });
        await tool('set_subtask_completed', { subtaskId: id, completed: true });
      }
      await tool('submit_implementation_review', {});
      await page.getByRole('button', { name: 'Review all reports (2)', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Implementation reports', exact: true });
      await expect(dialog.getByText('Completed task A', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Completed task B', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Revise all pending (2)', exact: true })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Reject all pending (2)', exact: true })).toBeDisabled();
      if (verdict === 'approved') {
        await fs.writeFile(join(repo, 'bulk-source.ts'), 'export const changed = true;');
        await dialog.getByRole('button', { name: 'Approve all pending (2)', exact: true }).click();
        await expect(dialog.getByRole('alert')).toContainText('source changed');
        expect((await state()).stages[3].subtasks.map((task: any) => task.review.status)).toEqual(['pending_review', 'pending_review']);
        await tool('submit_implementation_review', {});
        await dialog.getByRole('button', { name: 'Reload reports', exact: true }).click();
        await expect(dialog.getByRole('button', { name: 'Approve all pending (2)', exact: true })).toBeEnabled();
        await page.screenshot({ path: '/private/tmp/ai-pilot-bulk-review.png', fullPage: true });
      } else {
        await dialog.getByLabel('Comment for all pending implementations').fill('Fix validation for all pending tasks');
      }
      const label = verdict === 'approved' ? 'Approve' : verdict === 'needs_revision' ? 'Revise' : 'Reject';
      await dialog.getByRole('button', { name: label + ' all pending (2)', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      if (verdict === 'approved') {
        await expect.poll(async () => (await state()).stages[3].subtasks.map((task: any) => task.review.status)).toEqual(['approved', 'approved']);
        await expect(page.getByRole('button', { name: 'Advance stage', exact: true })).toBeVisible();
      } else {
        const revised = await state();
        for (const task of revised.stages[3].subtasks) {
          expect(task.completed).toBe(false);
          expect(task.attempt).toBe(1);
          expect(task.reviewHistory.at(-1)).toMatchObject({ status: verdict, comment: 'Fix validation for all pending tasks' });
        }
        expect(revised.currentStageId).toBe('develop');
      }
    } finally { await client.close(); }
  });
}

test('development workspace keeps reports readable, ignores late reads and approves the next task', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const repoId = (await (await page.request.post('/api/repos', { data: { path: repo } })).json()).id;
  const ticketId = 'E2E-WORKSPACE';
  const url = '/api/repos/' + repoId + '/specs/' + ticketId;
  const client = await mcpClient();
  const tool = async (name: string, args: Record<string, unknown>) => {
    expect((await client.callTool({ name, arguments: { repoId, ticketId, ...args } })).isError).not.toBe(true);
  };
  const state = async () => (await page.request.get(url)).json();
  let releaseA!: () => void;
  let requestedA!: () => void;
  const holdA = new Promise<void>(resolve => { releaseA = resolve; });
  const startedA = new Promise<void>(resolve => { requestedA = resolve; });
  try {
    await tool('create_spec', { title: 'Readable implementation review', workflowKind: 'bugfix' });
    await tool('record_ai_output', { stageId: 'spec', content: 'Shipping requirements' });
    await page.goto(url.replace('/api', ''));
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(async () => (await state()).stages[0].gate.status).toBe('approved');
    await tool('advance_stage', { stageId: 'spec' });
    const description = 'Validate shipping. ' + 'Full task requirements remain available without becoming a report heading. '.repeat(15);
    await tool('set_develop_subtasks', { subtasks: [{ id: 'A', title: 'Shipping validation', description, files: ['source.ts'] }, { id: 'B', title: 'Boundary tests', description: 'Cover shipping boundaries', files: ['source.ts'], dependsOn: ['A'] }] });
    await tool('record_ai_output', { stageId: 'develop', content: 'Approved development plan' });
    await page.getByRole('button', { name: 'Select DEVELOP', exact: true }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(async () => (await state()).stages[3].gate.status).toBe('approved');
    await page.route('**/develop/review?subtaskId=A', async route => { requestedA(); await holdA; await route.continue(); });
    for (const id of ['A', 'B']) {
      await tool('log_implementation', { subtaskId: id, summary: 'Summary for ' + id, filesModified: ['source.ts'], filesCreated: [], statistics: { linesAdded: 1, linesRemoved: 0 }, artifacts: {} });
      await tool('set_subtask_completed', { subtaskId: id, completed: true });
    }
    await tool('submit_implementation_review', {});
    await startedA;
    await page.getByRole('button', { name: 'Select task Boundary tests', exact: true }).click();
    const detail = page.getByRole('region', { name: 'Selected task detail' });
    await expect(detail.getByText('Summary for B', { exact: true })).toBeVisible();
    const lateResponse = page.waitForResponse(response => response.url().endsWith('/develop/review?subtaskId=A'));
    releaseA();
    await lateResponse;
    await expect(detail.getByRole('heading', { name: 'Boundary tests', exact: true })).toBeVisible();
    await expect(detail.getByText('Summary for A', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Select task Shipping validation', exact: true }).click();
    await expect(detail.getByText('Summary for A', { exact: true })).toBeVisible();
    await expect(detail.locator('.implementation-technical pre')).not.toBeVisible();
    await detail.getByRole('tab', { name: 'Task requirements', exact: true }).click();
    await expect(detail.getByText(description, { exact: true })).toBeVisible();
    await detail.getByRole('tab', { name: 'Implementation report', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Select DEVELOP' })).toHaveAttribute('title', /implementation review incomplete/);
    await page.screenshot({ path: '/private/tmp/ai-pilot-develop-workspace.png', fullPage: true });
    await detail.getByRole('button', { name: 'Approve & next', exact: true }).click();
    await expect(detail.getByRole('heading', { name: 'Boundary tests', exact: true })).toBeVisible();
    await expect.poll(async () => (await state()).stages[3].subtasks[0].review.status).toBe('approved');
    expect((await state()).stages[3].subtasks[1].review.status).toBe('pending_review');
    await page.getByRole('button', { name: 'Pending review 1', exact: true }).click();
    await expect(page.locator('.develop-task-row')).toHaveCount(1);
    await page.getByLabel('Search development tasks').fill('no matching task');
    await expect(page.getByText('No tasks match your filters.')).toBeVisible();
    await page.getByLabel('Search development tasks').fill('');
    await page.setViewportSize({ width: 1280, height: 720 });
    const action = await detail.getByRole('button', { name: 'Approve & next', exact: true }).boundingBox();
    expect(action!.y + action!.height).toBeLessThanOrEqual(720);
    // A long report scrolls the handoff out of view while review controls stay accessible.
    await page.getByRole('button', { name: 'All 2', exact: true }).click();
    await page.getByRole('button', { name: 'Select task Shipping validation', exact: true }).click();
    await detail.getByRole('tab', { name: 'Task requirements', exact: true }).click();
    const stageContent = page.getByRole('region', { name: 'Stage content', exact: true });
    await stageContent.evaluate(element => { element.scrollTop = 250; });
    await expect(page.getByRole('button', { name: 'Copy context', exact: true })).not.toBeInViewport();
    await expect(detail.getByRole('button', { name: 'Next task', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Select task Boundary tests', exact: true })).toBeInViewport();
    await page.getByRole('button', { name: 'Select task Boundary tests', exact: true }).click();
    await expect(detail.getByRole('heading', { name: 'Boundary tests', exact: true })).toBeInViewport();
    await expect(detail.getByRole('button', { name: 'Approve & next', exact: true })).toBeInViewport();
    await page.setViewportSize({ width: 600, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(600);
  } finally { releaseA(); await client.close(); }
});

test('Create Spec imports Jira without starting an agent, ignores stale reads and preserves manual edits', async ({ page }) => {
  const state = await mockDashboard(page);
  await page.route('**/api/integrations/jira', route => route.fulfill({ json: { configured: true } }));
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let releaseRefresh!: () => void;
  const holdRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  let fastRequests = 0;
  await page.route('**/api/integrations/jira/issue', async route => {
    expect(route.request().headers()['x-specflow-review-session']).toBe('ui-review-token');
    const { ticketId } = route.request().postDataJSON();
    if (ticketId === 'SLOW-1') await hold;
    if (ticketId === 'FAST-2' && ++fastRequests > 1) await holdRefresh;
    await route.fulfill({ json: { key: ticketId, summary: 'Jira ' + ticketId, description: 'Given an order\nThen calculate shipping' } });
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create Spec', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Spec' });
    await dialog.getByLabel('Ticket ID', { exact: true }).fill('SLOW-1');
    await expect(dialog.getByText('Loading Jira ticket…')).toBeVisible();
    await dialog.getByLabel('Ticket ID', { exact: true }).fill('FAST-2');
    await expect(dialog.getByLabel('Description', { exact: true })).toHaveValue('Jira FAST-2\n\nGiven an order\nThen calculate shipping');
    const oldResponse = page.waitForResponse(response => response.url().endsWith('/jira/issue') && response.request().postDataJSON().ticketId === 'SLOW-1');
    release();
    await oldResponse;
    await expect(dialog.getByText('Imported FAST-2 from Jira. You can edit the requirements below.')).toBeVisible();
    expect(state.creations).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Replace from Jira', exact: true }).click();
    await expect(dialog.getByText('Loading Jira ticket…')).toBeVisible();
    await dialog.getByLabel('Description', { exact: true }).fill('My revised requirements');
    const refreshed = page.waitForResponse(response => response.url().endsWith('/jira/issue') && response.request().postDataJSON().ticketId === 'FAST-2');
    releaseRefresh();
    await refreshed;
    await expect(dialog.getByLabel('Description', { exact: true })).toHaveValue('My revised requirements');
    await dialog.getByRole('button', { name: 'Create & Start', exact: true }).click();
    await expect.poll(() => state.creations.length).toBe(1);
    expect(state.creations[0]).toMatchObject({ ticketId: 'FAST-2', title: 'My revised requirements', description: 'My revised requirements', autoRun: true });
  } finally { release(); releaseRefresh(); }
});

test('Jira authentication failure leaves Create Spec usable with manual requirements', async ({ page }) => {
  await mockDashboard(page);
  await page.route('**/api/integrations/jira', route => route.fulfill({ json: { configured: true } }));
  await page.route('**/api/integrations/jira/issue', route => route.fulfill({ status: 502, json: { error: 'Jira authentication failed (401). Update the Jira MCP credentials and retry.' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create Spec', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Spec' });
  await dialog.getByLabel('Ticket ID', { exact: true }).fill('AUTH-1');
  await expect(dialog.getByText(/Jira authentication failed/)).toBeVisible();
  await dialog.getByLabel('Description', { exact: true }).fill('Manual requirements');
  await expect(dialog.getByRole('button', { name: 'Create & Start', exact: true })).toBeEnabled();
});

test('SAP SSO is explicit and retries the ticket after authentication without creating a spec', async ({ page }) => {
  const state = await mockDashboard(page);
  let signedIn = false;
  let loginRequests = 0;
  await page.route('**/api/integrations/jira', route => route.fulfill({ json: { configured: true, authenticationAvailable: true } }));
  await page.route('**/api/integrations/jira/issue', route => signedIn
    ? route.fulfill({ json: { key: 'SSO-1', summary: 'SAP Jira summary', description: 'Acceptance criteria' } })
    : route.fulfill({ status: 502, json: { error: 'Sign in to Jira with SAP SSO, then retry the lookup.', code: 'SAP_AUTH_REQUIRED' } }));
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/integrations/jira/authenticate', async route => {
    expect(route.request().postDataJSON()).toEqual({});
    expect(route.request().headers()['x-specflow-review-session']).toBe('ui-review-token');
    loginRequests++;
    await hold; signedIn = true;
    await route.fulfill({ json: { authenticated: true } });
  });
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create Spec', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Spec' });
    await dialog.getByLabel('Ticket ID', { exact: true }).fill('SSO-1');
    await expect(dialog.getByRole('alert')).toContainText('Sign in to Jira with SAP SSO');
    expect(loginRequests).toBe(0);
    await dialog.getByRole('button', { name: 'Sign in to Jira', exact: true }).click();
    await expect(dialog.getByText(/Complete SAP SSO in the browser/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Signing in…', exact: true })).toBeDisabled();
    release();
    await expect(dialog.getByLabel('Description', { exact: true })).toHaveValue('SAP Jira summary\n\nAcceptance criteria');
    expect(loginRequests).toBe(1);
    expect(state.creations).toHaveLength(0);
  } finally { release(); }
});
