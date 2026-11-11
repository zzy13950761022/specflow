import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AppCore } from '../core/app-core.js';
import { AgentKindSchema, AgentProfileSchema } from '../core/agent-profile.js';
import { detectAgent } from '../automation/agent-detection.js';
import { runAgentTurn } from '../automation/agent-adapters.js';

export function registerAgentRoutes(server: FastifyInstance, app: AppCore) {
  server.get('/api/agents/settings', async (_request, reply) => { reply.header('cache-control', 'no-store'); return app.agentSettings.load(); });
  server.put('/api/agents/settings', async (request, reply) => {
    try { return await app.agentSettings.save(request.body); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  server.post('/api/agents/detect', async (request, reply) => {
    const input = z.object({ agent: AgentKindSchema, command: z.string().min(1).optional(), configPath: z.string().min(1).optional() }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Select an Agent and optional executable/configuration path.' });
    return detectAgent({ ...input.data, id: 'detect', name: 'Detect', version: 1 });
  });
  let testing = false;
  server.post('/api/agents/test', async (request, reply) => {
    const input = z.object({ profile: AgentProfileSchema }).safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'Invalid Agent profile.' });
    if (testing) return reply.code(409).send({ error: 'An Agent connection test is already running.' });
    testing = true;
    const checks: Array<{ name: string; status: 'passed' | 'failed' | 'skipped'; message: string }> = [];
    let root: string | undefined;
    try {
      const detected = await detectAgent(input.data.profile);
      checks.push({ name: 'Native program', status: detected.available ? 'passed' : 'failed', message: detected.available ? detected.version ?? 'Available' : detected.error! });
      if (!detected.available || detected.error) {
        checks.push({ name: 'Configuration', status: 'failed', message: detected.error ?? 'Configuration unavailable.' });
        return { ok: false, checks };
      }
      checks.push({ name: 'Configuration', status: 'passed', message: 'Selected native configuration can be loaded.' });
      root = await fs.mkdtemp(join(tmpdir(), 'ai-pilot-agent-test-'));
      const workspace = join(root, 'workspace'); await fs.mkdir(workspace);
      const result = await runAgentTurn({ profile: input.data.profile, cwd: workspace, runtime: join(root, 'runtime'), prompt: 'Connection test. Do not use tools or read files. Return only {"ok":true}.', schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }, signal: AbortSignal.timeout(60_000), timeoutMs: 60_000 });
      const success = z.object({ ok: z.literal(true) }).safeParse(JSON.parse(result.text)).success;
      checks.push({ name: 'Model request', status: success ? 'passed' : 'failed', message: success ? 'Model responded through the selected Agent.' : 'Unexpected model response.' });
      return { ok: success, checks };
    } catch (error) {
      checks.push({ name: 'Model request', status: 'failed', message: (error as Error).message });
      return { ok: false, checks };
    } finally { testing = false; if (root) await fs.rm(root, { recursive: true, force: true }); }
  });
}
