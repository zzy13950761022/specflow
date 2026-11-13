import { promises as fs } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const Config = z.object({
  command: z.string().min(1), args: z.array(z.string()).default([]),
  cwd: z.string().refine(isAbsolute).optional(), env: z.record(z.string()).optional(),
}).strict();
const Issue = z.object({ key: z.string(), summary: z.string().trim().min(1).max(1000), description: z.string().nullable().optional() });
export const JiraTicketId = z.string().trim().transform(value => value.toUpperCase()).pipe(z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/, 'Enter a Jira Ticket ID such as PROJECT-123.').max(100));

class JiraImportError extends Error {}

export class JiraIntegration {
  constructor(private configPath = process.env.SPECFLOW_JIRA_MCP_CONFIG ?? join(process.env.SPECFLOW_HOME ?? process.env.AI_PILOT_HOME ?? join(homedir(), '.specflow'), 'jira-mcp.json'), private timeoutMs = 20_000) {}
  private async config() {
    try { return Config.parse(JSON.parse(await fs.readFile(this.configPath, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new JiraImportError('Jira MCP configuration is invalid or unreadable. Check jira-mcp.json on the Dashboard host.');
    }
  }
  async status() { return { configured: !!await this.config() }; }
  async issue(input: string) {
    const parsed = JiraTicketId.safeParse(input);
    if (!parsed.success) throw new JiraImportError('Enter a Jira Ticket ID such as PROJECT-123.');
    const key = parsed.data;
    const config = await this.config();
    if (!config) throw new JiraImportError('Jira MCP is not configured. Configure jira-mcp.json or enter the description manually.');
    const client = new Client({ name: 'specflow-jira-import', version: '1.0.0' });
    const transport = new StdioClientTransport({ ...config, stderr: 'pipe' });
    // Do not forward raw MCP stderr: it may contain Jira response details or credentials.
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport, { timeout: this.timeoutMs });
      const tools = await client.listTools({}, { timeout: this.timeoutMs });
      if (!tools.tools.some(tool => tool.name === 'get_issue' && tool.inputSchema.properties?.issueKey)) throw new JiraImportError('The Jira MCP must provide get_issue with an issueKey argument.');
      const result = await client.callTool({ name: 'get_issue', arguments: { issueKey: key, fields: 'summary,description' } }, undefined, { timeout: this.timeoutMs });
      const content = Array.isArray(result.content) ? result.content.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';
      if (result.isError) {
        if (/\b401\b/.test(content)) throw new JiraImportError('Jira authentication failed (401). Update the Jira MCP credentials and retry.');
        if (/\b403\b/.test(content)) throw new JiraImportError('Jira access denied (403). Check the account permissions.');
        if (/\b404\b/.test(content)) throw new JiraImportError('Jira ticket not found or not accessible (404). Check the Ticket ID and permissions.');
        if (/\b429\b/.test(content)) throw new JiraImportError('Jira rate limit reached (429). Wait before retrying, or enter the description manually.');
        throw new JiraImportError('Jira lookup failed. Check the MCP connection and credentials, or enter the description manually.');
      }
      let issue: z.infer<typeof Issue>;
      try { issue = Issue.parse(JSON.parse(content)); }
      catch { throw new JiraImportError('Jira returned an unsupported issue response. Expected a summary and text description.'); }
      if (issue.key !== key) throw new JiraImportError('Jira returned a different ticket. Import was cancelled.');
      const description = issue.description ?? '';
      if ((issue.summary + '\n\n' + description).length > 30000) throw new JiraImportError('Jira requirements exceed 30,000 characters. Enter the relevant requirements manually.');
      return { key: issue.key, summary: issue.summary, description };
    } catch (error) {
      const message = (error as Error).message ?? '';
      if (/timed out|timeout/i.test(message)) throw new JiraImportError('Jira lookup timed out. Retry or enter the description manually.');
      if (error instanceof JiraImportError) throw error;
      throw new JiraImportError('Unable to connect to Jira MCP. Check its command and credentials, then retry.');
    } finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
  }
}
