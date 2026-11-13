import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFileSync } from 'node:fs';
const server = new McpServer({ name: 'jira-fixture', version: '1' });
server.registerTool('get_issue', { inputSchema: { issueKey: z.string(), fields: z.string() } }, async ({ issueKey }) => {
  if (process.env.JIRA_AUDIT) appendFileSync(process.env.JIRA_AUDIT, 'get_issue\n');
  if (issueKey === 'AUTH-1') return { isError: true, content: [{ type: 'text', text: 'HTTP 401 private-token-must-not-escape' }] };
  if (issueKey === 'WAIT-1') await new Promise(resolve => setTimeout(resolve, 10000));
  return { content: [{ type: 'text', text: JSON.stringify({ key: issueKey === 'WRONG-1' ? 'OTHER-1' : issueKey, summary: 'Shipping validation', description: 'Given an order\nThen calculate shipping', assignee: 'private-person' }) }] };
});
await server.connect(new StdioServerTransport());
