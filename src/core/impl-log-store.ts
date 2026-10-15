import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  ImplementationLogSchema,
  type ImplementationLog,
  type ImplArtifacts,
} from './schemas.js';

/**
 * Reads/writes per-subtask implementation logs under
 * <repo>/.specflow/impl-logs/{ticketId}/task-{subtaskId}_{timestamp}_{id}.md
 *
 * Logs are append-only markdown files (never mutated after write). The store
 * provides list + optional subtask filter for context feeding into test/build.
 */
export class ImplLogStore {
  private logsDir(repoPath: string, ticketId: string): string {
    return join(repoPath, '.specflow', 'impl-logs', ticketId);
  }

  private sanitize(id: string): string {
    return id.replace(/[^a-zA-Z0-9-]/g, '-');
  }

  async write(
    repoPath: string,
    ticketId: string,
    subtaskId: string,
    input: {
      summary: string;
      filesModified: string[];
      filesCreated: string[];
      statistics: { linesAdded: number; linesRemoved: number };
      artifacts: ImplArtifacts;
    }
  ): Promise<ImplementationLog> {
    const id = randomUUID();
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', 'T').slice(0, 19);
    const log: ImplementationLog = {
      id,
      ticketId,
      subtaskId,
      summary: input.summary,
      filesModified: input.filesModified,
      filesCreated: input.filesCreated,
      statistics: input.statistics,
      artifacts: input.artifacts,
      createdAt: now.toISOString(),
    };

    const dir = this.logsDir(repoPath, ticketId);
    await fs.mkdir(dir, { recursive: true });
    const filename = `task-${this.sanitize(subtaskId)}_${ts}_${id.slice(0, 8)}.md`;
    const content = this.toMarkdown(log);
    await fs.writeFile(join(dir, filename), content, 'utf-8');
    return log;
  }

  async list(repoPath: string, ticketId: string, subtaskId?: string): Promise<ImplementationLog[]> {
    const dir = this.logsDir(repoPath, ticketId);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return [];
    }
    const logs: ImplementationLog[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith('.md')) continue;
      const raw = await fs.readFile(join(dir, file), 'utf-8').catch(() => null);
      if (!raw) continue;
      const parsed = this.fromMarkdown(raw);
      if (parsed && (!subtaskId || parsed.subtaskId === subtaskId)) {
        logs.push(parsed);
      }
    }
    return logs;
  }

  private toMarkdown(log: ImplementationLog): string {
    const a = log.artifacts;
    const sections: string[] = [];

    if (a.apiEndpoints?.length) {
      sections.push('### API Endpoints\n' + a.apiEndpoints.map((e) =>
        `#### ${e.method} ${e.path}\n- **Purpose:** ${e.purpose}\n- **Location:** ${e.location}` +
        (e.requestFormat ? `\n- **Request:** ${e.requestFormat}` : '') +
        (e.responseFormat ? `\n- **Response:** ${e.responseFormat}` : '')
      ).join('\n\n'));
    }
    if (a.components?.length) {
      sections.push('### Components\n' + a.components.map((c) =>
        `#### ${c.name}\n- **Type:** ${c.type}\n- **Purpose:** ${c.purpose}\n- **Location:** ${c.location}` +
        (c.props ? `\n- **Props:** ${c.props}` : '') +
        (c.exports?.length ? `\n- **Exports:** ${c.exports.join(', ')}` : '')
      ).join('\n\n'));
    }
    if (a.functions?.length) {
      sections.push('### Functions\n' + a.functions.map((f) =>
        `#### ${f.name}\n- **Purpose:** ${f.purpose}\n- **Location:** ${f.location}` +
        (f.signature ? `\n- **Signature:** ${f.signature}` : '') +
        `\n- **Exported:** ${f.isExported}`
      ).join('\n\n'));
    }
    if (a.classes?.length) {
      sections.push('### Classes\n' + a.classes.map((c) =>
        `#### ${c.name}\n- **Purpose:** ${c.purpose}\n- **Location:** ${c.location}` +
        (c.methods?.length ? `\n- **Methods:** ${c.methods.join(', ')}` : '') +
        `\n- **Exported:** ${c.isExported}`
      ).join('\n\n'));
    }
    if (a.integrations?.length) {
      sections.push('### Integrations\n' + a.integrations.map((i) =>
        `#### Integration\n- **Description:** ${i.description}\n- **Frontend:** ${i.frontendComponent}\n- **Backend:** ${i.backendEndpoint}\n- **Data Flow:** ${i.dataFlow}`
      ).join('\n\n'));
    }

    return `# Implementation Log: ${log.subtaskId}

**Summary:** ${log.summary}
**Timestamp:** ${log.createdAt}
**Log ID:** ${log.id}
**Ticket:** ${log.ticketId}

---

## Statistics
- **Lines Added:** +${log.statistics.linesAdded}
- **Lines Removed:** -${log.statistics.linesRemoved}
- **Files Changed:** ${log.filesModified.length + log.filesCreated.length}

## Files Modified
${log.filesModified.length ? log.filesModified.map((f) => `- ${f}`).join('\n') : '_None_'}

## Files Created
${log.filesCreated.length ? log.filesCreated.map((f) => `- ${f}`).join('\n') : '_None_'}

---

## Artifacts

${sections.length ? sections.join('\n\n') : '_No artifacts recorded_'}
`;
  }

  private fromMarkdown(raw: string): ImplementationLog | null {
    try {
      const id = raw.match(/\*\*Log ID:\*\* ([a-f0-9-]+)/)?.[1] ?? randomUUID();
      const ticketId = raw.match(/\*\*Ticket:\*\* (.+)/)?.[1]?.trim() ?? '';
      const subtaskId = raw.match(/^# Implementation Log: (.+)/m)?.[1]?.trim() ?? '';
      const summary = raw.match(/\*\*Summary:\*\* (.+)/)?.[1]?.trim() ?? '';
      const createdAt = raw.match(/\*\*Timestamp:\*\* (.+)/)?.[1]?.trim() ?? new Date().toISOString();
      const linesAdded = parseInt(raw.match(/\*\*Lines Added:\*\* \+(\d+)/)?.[1] ?? '0', 10);
      const linesRemoved = parseInt(raw.match(/\*\*Lines Removed:\*\* -(\d+)/)?.[1] ?? '0', 10);

      const modifiedSection = raw.match(/## Files Modified\n([\s\S]*?)(?=\n##)/)?.[1] ?? '';
      const createdSection = raw.match(/## Files Created\n([\s\S]*?)(?=\n##)/)?.[1] ?? '';
      const filesModified = modifiedSection.match(/^- (.+)$/gm)?.map((l) => l.slice(2)) ?? [];
      const filesCreated = createdSection.match(/^- (.+)$/gm)?.map((l) => l.slice(2)) ?? [];

      const log: ImplementationLog = {
        id, ticketId, subtaskId, summary, createdAt,
        filesModified, filesCreated,
        statistics: { linesAdded, linesRemoved },
        artifacts: {},
      };
      return ImplementationLogSchema.parse(log);
    } catch {
      return null;
    }
  }
}
