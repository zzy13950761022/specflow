import { useEffect, useRef, useState } from 'react';
import type { InlineAnnotation } from '../types';

interface AnnotationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (annotation: InlineAnnotation) => void;
  onRemove: (id: string) => void;
  selectedText: string;
  initialComment: string;
  annotationId: string;
  mode: 'create' | 'edit';
}

export function AnnotationModal({
  isOpen,
  onClose,
  onSave,
  onRemove,
  selectedText,
  initialComment,
  annotationId,
  mode,
}: AnnotationModalProps) {
  const [comment, setComment] = useState(initialComment);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync comment when modal reopens with a different annotation
  useEffect(() => {
    setComment(initialComment);
  }, [initialComment, annotationId]);

  // Autofocus textarea when modal opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  function handleSave() {
    if (!comment.trim()) return;
    onSave({ id: annotationId, selectedText, comment: comment.trim() });
    onClose();
  }

  function handleRemove() {
    onRemove(annotationId);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="glass rounded-2xl p-5 flex flex-col gap-4 w-full max-w-md shadow-lg">
        {/* Quoted selection */}
        <blockquote className="border-l-4 border-orange-300 bg-orange-50 px-3 py-2 rounded-r-lg text-sm italic text-slate-600 line-clamp-4">
          {selectedText}
        </blockquote>

        {/* Comment input */}
        <textarea
          ref={textareaRef}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Add your revision note…"
          rows={3}
          className="bg-gray-50 border border-blue-200 focus:border-blue-500 rounded-lg px-3 py-2 text-sm outline-none resize-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave();
          }}
        />

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={handleSave}
            disabled={!comment.trim()}
            className="rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-sm px-4 py-2 font-medium disabled:opacity-50"
          >
            Save
          </button>
          <button
            onClick={handleRemove}
            disabled={mode === 'create'}
            className="rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm px-4 py-2 font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Remove
          </button>
          <button
            onClick={onClose}
            className="text-sm text-slate-500 hover:text-slate-700 px-2"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
