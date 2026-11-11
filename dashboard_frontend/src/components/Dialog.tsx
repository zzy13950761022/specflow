import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Native modal semantics provide inert background, focus containment and Escape. */
export function Dialog({ title, onClose, busy = false, children }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return createPortal(
    <dialog ref={ref} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const elements = Array.from(ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')).filter((element) => element.getClientRects().length > 0);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} className="app-dialog glass rounded-2xl p-0">
      <div className="dialog-header bg-white border-b border-blue-100 flex items-center justify-between px-6 py-4 z-10">
        <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
        <button type="button" aria-label="Close dialog" disabled={busy} onClick={onClose} className="rounded-lg px-2 py-1 hover:bg-blue-50 disabled:opacity-50">✕</button>
      </div>
      {children}
    </dialog>, document.body,
  );
}
