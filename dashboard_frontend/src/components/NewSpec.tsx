import { useState } from 'react';

export function NewSpec({ onCreate }: { onCreate: (ticketId: string, title: string) => void }) {
  const [ticketId, setTicketId] = useState('');
  const [title, setTitle] = useState('');
  return (
    <div className="glass rounded-2xl p-3 flex gap-2 items-center">
      <input
        value={ticketId}
        onChange={(e) => setTicketId(e.target.value)}
        placeholder="TICKET-123"
        className="bg-gray-100 rounded-lg px-3 py-2 text-sm outline-none border border-blue-200 focus:border-blue-500 w-36"
      />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Feature title"
        className="bg-gray-100 rounded-lg px-3 py-2 text-sm outline-none border border-blue-200 focus:border-blue-500 flex-1"
      />
      <button
        onClick={() => {
          if (ticketId.trim() && title.trim()) {
            onCreate(ticketId.trim(), title.trim());
            setTicketId('');
            setTitle('');
          }
        }}
        className="joule-gradient rounded-lg px-4 py-2 text-sm font-medium text-white"
      >
        Create spec
      </button>
    </div>
  );
}
