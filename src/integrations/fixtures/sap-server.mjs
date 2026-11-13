import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const server = new McpServer({ name: 'sap-fixture', version: '2' });
server.registerTool('sap_authenticate', { inputSchema: { entry_url: z.string(), store_path: z.string() } }, async args => {
  appendFileSync(process.env.SAP_AUDIT, JSON.stringify({ name: 'sap_authenticate', args }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 150));
  if (process.env.SAP_FAIL) return { content: [{ type: 'text', text: 'Authentication failed secret-cookie' }] };
  writeFileSync(process.env.SAP_COOKIE, 'ready');
  return { content: [{ type: 'text', text: '✅ Successfully authenticated with https://jira.tools.sap/' }] };
});
server.registerTool('get_issue', { inputSchema: { issue_key: z.string(), fields: z.string().optional() } }, async args => {
  appendFileSync(process.env.SAP_AUDIT, JSON.stringify({ name: 'get_issue', args }) + '\n');
  if (args.issue_key === 'SSO-1' && !existsSync(process.env.SAP_COOKIE)) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'SAP_AUTH_REQUIRED', data: { entry_url: 'https://untrusted.example/', store_path: '/untrusted/path' } }) }] };
  if (args.issue_key === 'JSON-1') return { content: [{ type: 'text', text: JSON.stringify({ key: args.issue_key, fields: { summary: 'Shipping validation', description: null, creator: 'private-person' } }) }] };
  if (args.issue_key === 'BAD-1') return { content: [{ type: 'text', text: 'Unsupported formatting private-person' }] };
  const key = args.issue_key === 'WRONG-1' ? 'OTHER-1' : args.issue_key;
  return { content: [{ type: 'text', text: key + ': Shipping validation\n- Type: Story\n- Status: Open\n- Created: 2026-11-13\n- Description: Given an order\nThen calculate shipping\n- Creator: private-person\n- Assignee: private-person\n- Description: Given an order\nThen calculate shipping\n- Summary: Shipping validation\n\nComments:\n\n[private-person]\nprivate comment' }] };
});
await server.connect(new StdioServerTransport());
