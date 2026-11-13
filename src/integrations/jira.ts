import { promises as fs } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const Connection = z.object({
  command: z.string().min(1), args: z.array(z.string()).default([]),
  cwd: z.string().refine(isAbsolute).optional(), env: z.record(z.string()).optional(),
});
const Config = Connection.extend({
  auth: Connection.extend({
    entryUrl: z.string().url().refine(value => new URL(value).protocol === 'https:'),
    storePath: z.string().refine(isAbsolute),
  }).strict().optional(),
}).strict();
const Issue = z.object({ key: z.string(), summary: z.string().trim().min(1).max(1000), description: z.string().nullable().optional() });
export const JiraTicketId = z.string().trim().transform(value => value.toUpperCase()).pipe(z.string().regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/, 'Enter a Jira Ticket ID such as PROJECT-123.').max(100));

export class JiraImportError extends Error {
  constructor(message: string, readonly code?: 'SAP_AUTH_REQUIRED') { super(message); }
}
const signInRequired = () => new JiraImportError('Sign in to Jira with SAP SSO, then retry the lookup.', 'SAP_AUTH_REQUIRED');

function toolText(result: Record<string, unknown>) {
  return Array.isArray(result.content) ? result.content.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';
}
function normalizeIssue(result: Record<string, unknown>, text: string) {
  let data: unknown;
  try { data = result.structuredContent ?? JSON.parse(text); }
  catch {
    // sap-jira-mcp 2.2.x returns formatted text, including creator/assignee and
    // comments. Extract only the summary and description from its known format.
    const body = text.split('\n\nComments:')[0];
    const match = /^([A-Z][A-Z0-9_]*-[1-9][0-9]*): ([^\n]+)\n- Type: [^\n]*\n- Status: [^\n]*\n- Created: [^\n]*\n- Description: ([\s\S]*)\n- Creator: [^\n]*\n- Assignee: [^\n]*([\s\S]*)$/.exec(body);
    if (match) {
      // With explicit fields, upstream repeats description and summary after
      // the common metadata. Accept only matching copies, never arbitrary fields.
      const suffixes = ['', '\n- Summary: ' + match[2], '\n- Description: ' + match[3] + '\n- Summary: ' + match[2]];
      if (suffixes.includes(match[4])) data = { key: match[1], summary: match[2], description: match[3] === 'No description' ? '' : match[3] };
    }
  }
  if (data && typeof data === 'object' && 'fields' in data) {
    const raw = data as { key: unknown; fields: { summary?: unknown; description?: unknown } };
    data = { key: raw.key, summary: raw.fields?.summary, description: raw.fields?.description };
  }
  const issue = Issue.safeParse(data);
  if (!issue.success) throw new JiraImportError('Jira returned an unsupported issue response. Expected a summary and text description.');
  return issue.data;
}

export class JiraIntegration {
  private authentication: Promise<{ authenticated: true }> | null = null;
  constructor(private configPath = process.env.SPECFLOW_JIRA_MCP_CONFIG ?? join(process.env.SPECFLOW_HOME ?? process.env.AI_PILOT_HOME ?? join(homedir(), '.specflow'), 'jira-mcp.json'), private timeoutMs = 20_000, private authTimeoutMs = 420_000) {}
  private async config() {
    try { return Config.parse(JSON.parse(await fs.readFile(this.configPath, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new JiraImportError('Jira MCP configuration is invalid or unreadable. Check jira-mcp.json on the Dashboard host.');
    }
  }
  async status() {
    const config = await this.config();
    return { configured: !!config, ...(config?.auth ? { authenticationAvailable: true } : {}) };
  }
  private async connected<T>(config: z.infer<typeof Connection>, work: (client: Client) => Promise<T>) {
    const client = new Client({ name: 'specflow-jira-import', version: '1.0.0' });
    const transport = new StdioClientTransport({ ...config, stderr: 'pipe' });
    // Raw stderr can contain credentials, cookies or private Jira metadata.
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport, { timeout: this.timeoutMs });
      return await work(client);
    } finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
  }
  async authenticate() {
    if (this.authentication) return this.authentication;
    this.authentication = this.signIn();
    try { return await this.authentication; }
    finally { this.authentication = null; }
  }
  private async signIn(): Promise<{ authenticated: true }> {
    const config = await this.config();
    if (!config?.auth) throw new JiraImportError('SAP Auth MCP is not configured on the Dashboard host.');
    const { entryUrl, storePath, ...connection } = config.auth;
    try {
      return await this.connected(connection, async client => {
        // Use only host-configured paths and URLs, never parameters returned by Jira.
        const result = await client.callTool({ name: 'sap_authenticate', arguments: { entry_url: entryUrl, store_path: storePath } }, undefined, { timeout: this.authTimeoutMs });
        if (result.isError || !toolText(result).includes('Successfully authenticated with ')) throw new JiraImportError('SAP SSO sign-in did not complete. Retry and complete login in the browser on the Dashboard host.');
        return { authenticated: true };
      });
    } catch (error) {
      if (error instanceof JiraImportError) throw error;
      throw new JiraImportError('SAP SSO sign-in failed or timed out. Retry and complete login in the browser on the Dashboard host.');
    }
  }
  async issue(input: string) {
    const parsed = JiraTicketId.safeParse(input);
    if (!parsed.success) throw new JiraImportError('Enter a Jira Ticket ID such as PROJECT-123.');
    const key = parsed.data;
    const config = await this.config();
    if (!config) throw new JiraImportError('Jira MCP is not configured. Configure jira-mcp.json or enter the description manually.');
    const { auth: _auth, ...connection } = config;
    try {
      return await this.connected(connection, async client => {
        const tools = await client.listTools({}, { timeout: this.timeoutMs });
        const properties = tools.tools.find(tool => tool.name === 'get_issue')?.inputSchema.properties;
        const keyArgument = properties?.issue_key ? 'issue_key' : properties?.issueKey ? 'issueKey' : null;
        if (!keyArgument) throw new JiraImportError('The Jira MCP must provide get_issue with an issue_key or issueKey argument.');
        const result = await client.callTool({ name: 'get_issue', arguments: { [keyArgument]: key, ...(properties?.fields ? { fields: 'summary,description' } : {}) } }, undefined, { timeout: this.timeoutMs });
        const content = toolText(result);
        if (content.includes('SAP_AUTH_REQUIRED') && result.isError) throw signInRequired();
        if (result.isError) {
          if (/\b401\b/.test(content)) throw new JiraImportError('Jira authentication failed (401). Update the Jira MCP credentials and retry.');
          if (/\b403\b/.test(content)) throw new JiraImportError('Jira access denied (403). Check the account permissions.');
          if (/\b404\b/.test(content)) throw new JiraImportError('Jira ticket not found or not accessible (404). Check the Ticket ID and permissions.');
          if (/\b429\b/.test(content)) throw new JiraImportError('Jira rate limit reached (429). Wait before retrying, or enter the description manually.');
          throw new JiraImportError('Jira lookup failed. Check the MCP connection and credentials, or enter the description manually.');
        }
        const issue = normalizeIssue(result, content);
        if (issue.key !== key) throw new JiraImportError('Jira returned a different ticket. Import was cancelled.');
        const description = issue.description ?? '';
        if ((issue.summary + '\n\n' + description).length > 30000) throw new JiraImportError('Jira requirements exceed 30,000 characters. Enter the relevant requirements manually.');
        return { key: issue.key, summary: issue.summary, description };
      });
    } catch (error) {
      if (error instanceof JiraImportError) throw error;
      const message = (error as Error).message ?? '';
      if (message.includes('SAP_AUTH_REQUIRED')) throw signInRequired();
      if (/timed out|timeout/i.test(message)) throw new JiraImportError('Jira lookup timed out. Retry or enter the description manually.');
      throw new JiraImportError('Unable to connect to Jira MCP. Check its command and credentials, then retry.');
    }
  }
}
