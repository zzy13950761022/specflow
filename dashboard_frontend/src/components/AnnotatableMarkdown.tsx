import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AnnotationModal } from './AnnotationModal';
import type { InlineAnnotation } from '../types';

interface AnnotatableMarkdownProps {
  content: string;
  annotations: InlineAnnotation[];
  onAnnotationSave: (a: InlineAnnotation) => void;
  onAnnotationRemove: (id: string) => void;
}

// Walk text nodes in `root` and wrap occurrences of `text` in a <mark> element.
function wrapTextNodes(root: HTMLElement, text: string, annotationId: string) {
  if (!text.trim()) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodesToProcess: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.nodeValue && node.nodeValue.includes(text)) {
      nodesToProcess.push(node);
    }
  }
  for (const textNode of nodesToProcess) {
    const val = textNode.nodeValue ?? '';
    const idx = val.indexOf(text);
    if (idx < 0) continue;
    const mark = document.createElement('mark');
    mark.className =
      'bg-orange-100 border-b-2 border-orange-400 cursor-pointer rounded-sm annotation-mark';
    mark.dataset.annotationId = annotationId;
    mark.textContent = text;
    const after = val.slice(idx + text.length);
    textNode.nodeValue = val.slice(0, idx);
    textNode.parentNode?.insertBefore(mark, textNode.nextSibling);
    if (after) {
      const afterNode = document.createTextNode(after);
      mark.parentNode?.insertBefore(afterNode, mark.nextSibling);
    }
  }
}

// Remove all annotation marks, restoring plain text nodes.
function clearAnnotationMarks(root: HTMLElement) {
  const marks = Array.from(root.querySelectorAll<HTMLElement>('mark.annotation-mark'));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    const text = document.createTextNode(mark.textContent ?? '');
    parent.replaceChild(text, mark);
    parent.normalize();
  }
}

export function AnnotatableMarkdown({
  content,
  annotations,
  onAnnotationSave,
  onAnnotationRemove,
}: AnnotatableMarkdownProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    selectedText: string;
    initialComment: string;
    annotationId: string;
    mode: 'create' | 'edit';
  }>({
    isOpen: false,
    selectedText: '',
    initialComment: '',
    annotationId: '',
    mode: 'create',
  });

  // Re-apply highlight marks whenever annotations change (after markdown renders).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    clearAnnotationMarks(container);
    for (const ann of annotations) {
      wrapTextNodes(container, ann.selectedText, ann.id);
    }
  });

  function handleMouseUp() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const selectedText = sel.toString().trim();
    if (!selectedText) return;

    const container = containerRef.current;
    if (!container) return;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;

    // Don't re-open for already-annotated marks; let the click handler handle those.
    const focusNode = sel.focusNode;
    if (focusNode && (focusNode as HTMLElement).closest?.('mark.annotation-mark')) return;

    sel.removeAllRanges();

    setModalState({
      isOpen: true,
      selectedText,
      initialComment: '',
      annotationId: crypto.randomUUID(),
      mode: 'create',
    });
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const mark = target.closest<HTMLElement>('mark.annotation-mark');
    if (!mark) return;
    const id = mark.dataset.annotationId;
    if (!id) return;
    const ann = annotations.find((a) => a.id === id);
    if (!ann) return;
    setModalState({
      isOpen: true,
      selectedText: ann.selectedText,
      initialComment: ann.comment,
      annotationId: ann.id,
      mode: 'edit',
    });
  }

  return (
    <>
      <div
        ref={containerRef}
        className="md-body select-text"
        onMouseUp={handleMouseUp}
        onClick={handleClick}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
      <AnnotationModal
        isOpen={modalState.isOpen}
        onClose={() => setModalState((s) => ({ ...s, isOpen: false }))}
        onSave={onAnnotationSave}
        onRemove={onAnnotationRemove}
        selectedText={modalState.selectedText}
        initialComment={modalState.initialComment}
        annotationId={modalState.annotationId}
        mode={modalState.mode}
      />
    </>
  );
}
