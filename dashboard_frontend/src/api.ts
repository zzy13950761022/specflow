import type { RepoEntry, SpecFile, StageId, TemplateSummary } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listRepos: () => fetch('/api/repos').then((r) => json<RepoEntry[]>(r)),

  addRepo: (path: string) =>
    fetch('/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then((r) => json<RepoEntry>(r)),

  /**
   * Open the native OS folder picker (server-side) and register the chosen
   * folder. Resolves to null if the user cancelled (HTTP 204).
   */
  pickRepo: async (): Promise<RepoEntry | null> => {
    const res = await fetch('/api/repos/pick', { method: 'POST' });
    if (res.status === 204) return null;
    return json<RepoEntry>(res);
  },

  removeRepo: (id: string) =>
    fetch(`/api/repos/${id}`, { method: 'DELETE' }).then((r) => json(r)),

  listSpecs: (repoId: string) =>
    fetch(`/api/repos/${repoId}/specs`).then((r) => json<SpecFile[]>(r)),

  createSpec: (repoId: string, ticketId: string, title: string) =>
    fetch(`/api/repos/${repoId}/specs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId, title }),
    }).then((r) => json<SpecFile>(r)),

  approve: (repoId: string, ticketId: string, stageId: StageId) =>
    fetch(`/api/repos/${repoId}/specs/${ticketId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageId }),
    }).then((r) => json<SpecFile>(r)),

  reject: (repoId: string, ticketId: string, stageId: StageId, comment: string) =>
    fetch(`/api/repos/${repoId}/specs/${ticketId}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageId, comment }),
    }).then((r) => json<SpecFile>(r)),

  listTemplates: (repoId: string) =>
    fetch(`/api/repos/${repoId}/templates`).then((r) => json<TemplateSummary[]>(r)),

  markTemplateCurated: (repoId: string, stageId: StageId) =>
    fetch(`/api/repos/${repoId}/templates/${stageId}/curate`, {
      method: 'POST',
    }).then((r) => json<{ ok: boolean }>(r)),

  setSubtasks: (
    repoId: string,
    ticketId: string,
    subtasks: Array<{ description: string; prompt?: string; requirementRef?: string }>
  ) =>
    fetch(`/api/repos/${repoId}/specs/${ticketId}/develop/subtasks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subtasks }),
    }).then((r) => json<SpecFile>(r)),

  toggleSubtask: (repoId: string, ticketId: string, subtaskId: string) =>
    fetch(`/api/repos/${repoId}/specs/${ticketId}/develop/subtasks/${subtaskId}/toggle`, {
      method: 'PATCH',
    }).then((r) => json<SpecFile>(r)),
};

/** Subscribe to live backend events; returns an unsubscribe fn. */
export function connectWs(onEvent: (event: any) => void): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {
      /* ignore malformed frame */
    }
  };
  return () => ws.close();
}
