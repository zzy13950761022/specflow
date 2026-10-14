import type { RepoEntry, SpecFile, StageId } from './types';

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
