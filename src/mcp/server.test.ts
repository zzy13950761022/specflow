import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppCore } from '../core/app-core.js';
import { buildMcpServer } from './server.js';

let home: string;
let repo: string;
let app: AppCore;
let repoId: string;
let client: Client;

async function connect(app: AppCore): Promise<Client> {
  const server = buildMcpServer(app);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
  return c;
}

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-home-'));
  repo = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-repo-'));
  process.env.AI_PILOT_HOME = home;
  app = new AppCore();
  repoId = (await app.addRepo(repo)).id;
  client = await connect(app);
});

afterEach(async () => {
  await client.close();
  delete process.env.AI_PILOT_HOME;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(repo, { recursive: true, force: true });
});

describe('MCP server exposes the tool set', () => {
  it('lists all expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'advance_stage',
        'create_spec',
        'get_approval_status',
        'get_spec',
        'get_stage_prompt',
        'list_repos',
        'list_specs',
        'propose_repo_templates',
        'record_ai_output',
        'set_develop_subtasks',
        'toggle_subtask',
        'write_repo_template',
      ].sort()
    );
  });
});

describe('MCP tools drive real state on disk', () => {
  it('create_spec via MCP writes the spec json', async () => {
    await client.callTool({
      name: 'create_spec',
      arguments: { repoId, ticketId: 'ABC-1', title: 'Checkout Tax' },
    });
    const onDisk = await fs.readFile(join(repo, '.specflow', 'specs', 'ABC-1.json'), 'utf-8');
    expect(JSON.parse(onDisk).ticketId).toBe('ABC-1');
  });

  it('record_ai_output via MCP writes the artifact and emits an event', async () => {
    const events: string[] = [];
    app.events.subscribe((e) => events.push(e.type));
    await client.callTool({ name: 'create_spec', arguments: { repoId, ticketId: 'ABC-1', title: 'x' } });
    await client.callTool({
      name: 'record_ai_output',
      arguments: { repoId, ticketId: 'ABC-1', stageId: 'spec', content: '# body' },
    });
    const spec = await fs.readFile(join(repo, 'specs', 'ABC-1.md'), 'utf-8');
    expect(spec).toBe('# body');
    expect(events).toContain('spec.updated');
  });
});

describe('MCP advance_stage gating (the core guarantee)', () => {
  it('is REFUSED with GATE_NOT_APPROVED before approval', async () => {
    await client.callTool({ name: 'create_spec', arguments: { repoId, ticketId: 'ABC-1', title: 'x' } });
    await client.callTool({
      name: 'record_ai_output',
      arguments: { repoId, ticketId: 'ABC-1', stageId: 'spec', content: '# body' },
    });
    const res: any = await client.callTool({
      name: 'advance_stage',
      arguments: { repoId, ticketId: 'ABC-1', stageId: 'spec' },
    });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe('GATE_NOT_APPROVED');
  });

  it('succeeds after the dashboard approves (simulated via AppCore)', async () => {
    await client.callTool({ name: 'create_spec', arguments: { repoId, ticketId: 'ABC-1', title: 'x' } });
    await client.callTool({
      name: 'record_ai_output',
      arguments: { repoId, ticketId: 'ABC-1', stageId: 'spec', content: '# body' },
    });
    // Approval is a dashboard action in production; call AppCore directly here.
    await app.approve(repoId, 'ABC-1', 'spec');

    const status: any = await client.callTool({
      name: 'get_approval_status',
      arguments: { repoId, ticketId: 'ABC-1', stageId: 'spec' },
    });
    expect(parse(status).gate.status).toBe('approved');

    const res: any = await client.callTool({
      name: 'advance_stage',
      arguments: { repoId, ticketId: 'ABC-1', stageId: 'spec' },
    });
    expect(res.isError).toBeFalsy();
    expect(parse(res).stages[1].id).toBe('requirements');
  });
});

describe('MCP propose_repo_templates', () => {
  it('returns a RepoBrief with buildTool and testFramework', async () => {
    const res: any = await client.callTool({
      name: 'propose_repo_templates',
      arguments: { repoId },
    });
    const brief = parse(res);
    expect(brief).toHaveProperty('buildTool');
    expect(brief).toHaveProperty('testFramework');
    expect(brief).toHaveProperty('blueprintDefaults');
  });

  it('includes Maven/JUnit signals when pom.xml contains junit', async () => {
    await fs.writeFile(
      join(repo, 'pom.xml'),
      '<project><dependencies><dependency><groupId>junit</groupId></dependency></dependencies></project>',
      'utf-8'
    );
    const res: any = await client.callTool({
      name: 'propose_repo_templates',
      arguments: { repoId },
    });
    const brief = parse(res);
    expect(brief.buildTool).toBe('maven');
    expect(brief.testFramework).toContain('junit');
  });
});

describe('MCP write_repo_template', () => {
  it('persists the template and get_stage_prompt returns it over blueprint default', async () => {
    await client.callTool({ name: 'create_spec', arguments: { repoId, ticketId: 'T-1', title: 'x' } });

    await client.callTool({
      name: 'write_repo_template',
      arguments: { repoId, stageId: 'spec', content: '# My curated spec\n{{ticketId}}' },
    });

    const res: any = await client.callTool({
      name: 'get_stage_prompt',
      arguments: { repoId, ticketId: 'T-1', stageId: 'spec' },
    });
    const payload = parse(res);
    expect(payload.source).toBe('repo-draft');
    expect(payload.content).toContain('My curated spec');
    expect(payload.content).toContain('T-1');
  });
});

describe('MCP get_stage_prompt', () => {
  it('returns the stage-0 blueprint prompt with ticket interpolated', async () => {
    await client.callTool({ name: 'create_spec', arguments: { repoId, ticketId: 'ABC-1', title: 'Checkout Tax' } });
    const res: any = await client.callTool({
      name: 'get_stage_prompt',
      arguments: { repoId, ticketId: 'ABC-1', stageId: 'spec' },
    });
    const payload = parse(res);
    expect(payload.content).toContain('ABC-1');
    expect(payload.source).toBe('blueprint-default');
  });
});

describe('MCP set_develop_subtasks and toggle_subtask (Phase 3)', () => {
  it('set_develop_subtasks creates the subtask list', async () => {
    await client.callTool({ name: 'create_spec', arguments: { repoId, ticketId: 'T-1', title: 'x' } });
    const res: any = await client.callTool({
      name: 'set_develop_subtasks',
      arguments: {
        repoId,
        ticketId: 'T-1',
        subtasks: [{ description: 'Alpha' }, { description: 'Beta' }],
      },
    });
    expect(res.isError).toBeFalsy();
    const spec = parse(res);
    const develop = spec.stages.find((s: any) => s.id === 'develop');
    expect(develop.subtasks).toHaveLength(2);
    expect(develop.subtasks[0].description).toBe('Alpha');
  });

  it('toggle_subtask flips the task completed flag', async () => {
    await client.callTool({ name: 'create_spec', arguments: { repoId, ticketId: 'T-1', title: 'x' } });
    const setRes: any = await client.callTool({
      name: 'set_develop_subtasks',
      arguments: { repoId, ticketId: 'T-1', subtasks: [{ description: 'Do it' }] },
    });
    const subtaskId = parse(setRes).stages.find((s: any) => s.id === 'develop').subtasks[0].id;

    const toggleRes: any = await client.callTool({
      name: 'toggle_subtask',
      arguments: { repoId, ticketId: 'T-1', subtaskId },
    });
    expect(toggleRes.isError).toBeFalsy();
    const spec = parse(toggleRes);
    const task = spec.stages.find((s: any) => s.id === 'develop').subtasks[0];
    expect(task.completed).toBe(true);
  });

  it('toggle_subtask returns an error for an unknown subtask id', async () => {
    await client.callTool({ name: 'create_spec', arguments: { repoId, ticketId: 'T-1', title: 'x' } });
    const res: any = await client.callTool({
      name: 'toggle_subtask',
      arguments: { repoId, ticketId: 'T-1', subtaskId: 'nonexistent-uuid' },
    });
    expect(res.isError).toBe(true);
    expect(parse(res).error).toMatch(/unknown subtask/i);
  });
});
