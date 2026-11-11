import type { Artifact, RepoEntry, RequirementsData, SpecFile, StageId, TemplateSummary, WorkflowOptions, Subtask } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function workflowMutation(repoId: string, ticketId: string, path: string, body = {}) {
  return reviewFetch('/api/repos/' + encodeURIComponent(repoId) + '/specs/' + encodeURIComponent(ticketId) + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((response) => json<SpecFile>(response));
}

async function reviewFetch(url: string, options: RequestInit): Promise<Response> {
  const session = await fetch('/api/review-session').then((response) => json<{ token: string }>(response));
  return fetch(url, { ...options, headers: { ...options.headers, 'x-specflow-review-session': session.token } });
}

export const api = {
  automationAvailable: () => fetch('/api/automation').then((response) => json<{ available: boolean }>(response)),
  configureAutomation: (repoId: string, ticketId: string, enabled: boolean) => workflowMutation(repoId, ticketId, '/automation', { enabled }),
  retryAutomation: (repoId: string, ticketId: string) => workflowMutation(repoId, ticketId, '/automation/retry'),
  submitImplementationReview: (repoId: string, ticketId: string) => workflowMutation(repoId, ticketId, '/develop/submit-review'),
  reviewImplementation: (repoId: string, ticketId: string, subtaskId: string, expectedReviewId: string, verdict: 'approved' | 'rejected' | 'needs_revision', comment?: string) => workflowMutation(repoId, ticketId, '/develop/review', { subtaskId, expectedReviewId, verdict, comment }),
  implementationReview: (repoId: string, ticketId: string, subtaskId: string) => fetch('/api/repos/' + encodeURIComponent(repoId) + '/specs/' + encodeURIComponent(ticketId) + '/develop/review?subtaskId=' + encodeURIComponent(subtaskId)).then((response) => json<{ review: NonNullable<Subtask['review']>; content: string; sourceChanged: boolean }>(response)),
  reopen: (repoId: string, ticketId: string, stageId: StageId, reason: string) => workflowMutation(repoId, ticketId, '/reopen', { stageId, reason }),
  pause: (repoId: string, ticketId: string) => workflowMutation(repoId, ticketId, '/execution/pause'),
  resume: (repoId: string, ticketId: string) => workflowMutation(repoId, ticketId, '/execution/resume'),
  runCheck: (repoId: string, ticketId: string, stageId: 'test' | 'build') => workflowMutation(repoId, ticketId, '/checks', { stageId }),
  completeTask: (repoId: string, ticketId: string, subtaskId: string, completed: boolean, claimId?: string) => workflowMutation(repoId, ticketId, '/develop/completed', { subtaskId, completed, claimId }),
  execution: (repoId: string, ticketId: string) => fetch('/api/repos/' + repoId + '/specs/' + ticketId + '/execution').then((response) => json<{ status: string; error?: string; actions: Array<{ tool: string; reason: string }> }>(response)),
  advance: (repoId: string, ticketId: string, stageId: StageId) => workflowMutation(repoId, ticketId, '/advance', { stageId }),
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

  /** Fetch a single spec — cold-load fallback for the detail page on deep link / hard reload. */
  getSpec: (repoId: string, ticketId: string) =>
    fetch(`/api/repos/${repoId}/specs/${ticketId}`).then((r) => json<SpecFile>(r)),

  createSpec: (repoId: string, ticketId: string, title: string, options: WorkflowOptions = {}) =>
    reviewFetch(`/api/repos/${repoId}/specs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticketId, title, ...options }),
    }).then((r) => json<SpecFile>(r)),

  approve: (repoId: string, ticketId: string, stageId: StageId, expectedRevision: number) =>
    reviewFetch(`/api/repos/${repoId}/specs/${ticketId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageId, expectedRevision }),
    }).then((r) => json<SpecFile>(r)),

  reject: (repoId: string, ticketId: string, stageId: StageId, comment: string, expectedRevision: number) =>
    reviewFetch(`/api/repos/${repoId}/specs/${ticketId}/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageId, comment, expectedRevision }),
    }).then((r) => json<SpecFile>(r)),

  needsRevision: (repoId: string, ticketId: string, stageId: StageId, comment: string, expectedRevision: number) =>
    reviewFetch(`/api/repos/${repoId}/specs/${ticketId}/needs-revision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageId, comment, expectedRevision }),
    }).then((r) => json<SpecFile>(r)),

  listTemplates: (repoId: string) =>
    fetch(`/api/repos/${repoId}/templates`).then((r) => json<TemplateSummary[]>(r)),

  /** Fetch a stage's AI-generated artifact content and metadata for review before approving. */
  getArtifact: (repoId: string, ticketId: string, stageId: StageId) =>
    fetch(`/api/repos/${repoId}/specs/${ticketId}/artifact?stageId=${stageId}`).then((r) =>
      json<{
        stageId: StageId;
        revision: number;
        content: string;
        artifact: Artifact | null;
        /** Present only for the 'requirements' artifact kind. */
        data?: RequirementsData | null;
      }>(r)
    ),

  markTemplateCurated: (repoId: string, stageId: StageId) =>
    fetch(`/api/repos/${repoId}/templates/${stageId}/curate`, {
      method: 'POST',
    }).then((r) => json<{ ok: boolean }>(r)),

  setSubtasks: (
    repoId: string,
    ticketId: string,
    subtasks: Array<Partial<Subtask> & { description: string }>
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
