import { useState } from 'react';
import type { WorkflowOptions } from '../types';

export function NewSpec({ onCreate }: { onCreate: (ticketId: string, title: string, options: WorkflowOptions) => Promise<void> }) {
  const [ticketId, setTicketId] = useState('');
  const [title, setTitle] = useState('');
  const [workflowKind, setWorkflowKind] = useState<'standard' | 'bugfix' | 'documentation'>('standard');
  const [risk, setRisk] = useState<'low' | 'normal' | 'high'>('normal');
  const [autoChecks, setAutoChecks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true); setError(null);
    try {
      await onCreate(ticketId.trim(), title.trim(), { workflowKind, risk, autoChecks: risk === 'low' && autoChecks });
      setTicketId(''); setTitle('');
    } catch (error) { setError(String((error as Error).message)); }
    finally { setBusy(false); }
  }
  return (
    <div className="glass rounded-2xl p-3 flex flex-wrap gap-2 items-center">
      <input aria-label="Ticket ID" value={ticketId} onChange={(event) => setTicketId(event.target.value)} placeholder="TICKET-123" className="bg-gray-100 rounded-lg px-3 py-2 text-sm border border-blue-200 w-36" />
      <input aria-label="Title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Feature title" className="bg-gray-100 rounded-lg px-3 py-2 text-sm border border-blue-200 flex-1 min-w-40" />
      <select aria-label="Workflow type" value={workflowKind} onChange={(event) => setWorkflowKind(event.target.value as typeof workflowKind)} className="bg-gray-100 rounded-lg p-2 text-sm">
        <option value="standard">Standard feature</option><option value="bugfix">Bug fix</option><option value="documentation">Documentation only</option>
      </select>
      <select aria-label="Change risk" value={risk} onChange={(event) => setRisk(event.target.value as typeof risk)} className="bg-gray-100 rounded-lg p-2 text-sm">
        <option value="low">Low risk</option><option value="normal">Normal risk</option><option value="high">High risk</option>
      </select>
      {risk === 'low' && workflowKind !== 'documentation' && <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={autoChecks} onChange={(event) => setAutoChecks(event.target.checked)} />Approve passing test/build checks automatically</label>}
      <button disabled={busy || !ticketId.trim() || !title.trim()} onClick={create} className="joule-gradient rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Create spec</button>
      {error && <p role="alert" className="w-full text-sm text-red-600">{error}</p>}
    </div>
  );
}
