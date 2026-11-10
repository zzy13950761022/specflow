import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AnnotationModal } from './AnnotationModal';
import type { AnnotationRangeInfo, InlineAnnotation } from '../types';

interface AnnotatableMarkdownProps {
  content: string;
  annotations: InlineAnnotation[];
  onAnnotationSave: (a: InlineAnnotation) => void;
  onAnnotationRemove: (id: string) => void;
}

// Get XPath of a node relative to a root element.
function getXPath(node: Node, root: Node): string {
  if (node === root) return '.';
  const parts: string[] = [];
  let current: Node | null = node;
  while (current && current !== root) {
    const parent: Node | null = current.parentNode;
    if (!parent) break;
    const siblings: ChildNode[] = Array.from(parent.childNodes).filter(
      (n: ChildNode) =>
        n.nodeType === current!.nodeType &&
        (n.nodeType !== Node.ELEMENT_NODE ||
          (n as Element).tagName === (current as Element).tagName)
    );
    const idx = siblings.indexOf(current as ChildNode) + 1;
    if (current.nodeType === Node.ELEMENT_NODE) {
      parts.unshift(`${(current as Element).tagName.toLowerCase()}[${idx}]`);
    } else {
      parts.unshift(`text()[${idx}]`);
    }
    current = parent;
  }
  return parts.join('/');
}

// Resolve an XPath (relative to root) back to a Node.
function resolveXPath(xpath: string, root: Node): Node | null {
  if (xpath === '.') return root;
  const parts = xpath.split('/');
  let current: Node | null = root;
  for (const part of parts) {
    if (!current) return null;
    const textMatch = part.match(/^text\[(\d+)\]$/) || part.match(/^text\(\)\[(\d+)\]$/);
    if (textMatch) {
      const idx = parseInt(textMatch[1], 10);
      const textNodes: ChildNode[] = Array.from(current.childNodes).filter(
        (n: ChildNode) => n.nodeType === Node.TEXT_NODE
      );
      current = textNodes[idx - 1] ?? null;
    } else {
      const elemMatch = part.match(/^([a-z0-9]+)\[(\d+)\]$/i);
      if (!elemMatch) return null;
      const [, tag, idxStr] = elemMatch;
      const idx = parseInt(idxStr, 10);
      const siblings: ChildNode[] = Array.from(current.childNodes).filter(
        (n: ChildNode) =>
          n.nodeType === Node.ELEMENT_NODE &&
          (n as Element).tagName.toLowerCase() === tag.toLowerCase()
      );
      current = siblings[idx - 1] ?? null;
    }
  }
  return current;
}

// Capture range info from the current Selection relative to root.
function captureRangeInfo(range: Range, root: HTMLElement): AnnotationRangeInfo {
  return {
    startXPath: getXPath(range.startContainer, root),
    startOffset: range.startOffset,
    endXPath: getXPath(range.endContainer, root),
    endOffset: range.endOffset,
  };
}

// Restore a Range from saved info, relative to root. Returns null if nodes not found.
function restoreRange(info: AnnotationRangeInfo, root: HTMLElement): Range | null {
  const startNode = resolveXPath(info.startXPath, root);
  const endNode = resolveXPath(info.endXPath, root);
  if (!startNode || !endNode) return null;
  try {
    const range = document.createRange();
    range.setStart(startNode, info.startOffset);
    range.setEnd(endNode, info.endOffset);
    return range;
  } catch {
    return null;
  }
}

// Wrap a Range in a <mark> element, handling cross-element selections.
function wrapRange(range: Range, annotationId: string): void {
  const mark = document.createElement('mark');
  mark.className = 'annotation-mark';
  mark.dataset.annotationId = annotationId;
  try {
    // surroundContents only works for ranges within a single element.
    range.surroundContents(mark);
  } catch {
    // Cross-element range: extractContents + insert.
    const fragment = range.extractContents();
    mark.appendChild(fragment);
    range.insertNode(mark);
  }
}

// Remove all annotation marks, restoring plain content.
function clearAnnotationMarks(root: HTMLElement) {
  const marks = Array.from(root.querySelectorAll<HTMLElement>('mark.annotation-mark'));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
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
    pendingRangeInfo: AnnotationRangeInfo | null;
    pendingContextSnippet: string;
    mode: 'create' | 'edit';
  }>({
    isOpen: false,
    selectedText: '',
    initialComment: '',
    annotationId: '',
    pendingRangeInfo: null,
    pendingContextSnippet: '',
    mode: 'create',
  });

  // Re-apply highlight marks after every render (ReactMarkdown rebuilds DOM each render).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    clearAnnotationMarks(container);
    for (const ann of annotations) {
      if (!ann.rangeInfo) continue;
      const range = restoreRange(ann.rangeInfo, container);
      if (range) wrapRange(range, ann.id);
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

    // Ignore clicks on already-annotated marks.
    const focusNode = sel.focusNode;
    if (focusNode && (focusNode as HTMLElement).closest?.('mark.annotation-mark')) return;

    const rangeInfo = captureRangeInfo(range, container);

    // Capture surrounding context: full container text, find selection, grab ±60 chars.
    const fullText = container.textContent ?? '';
    const selStart = fullText.indexOf(selectedText);
    let contextSnippet = '';
    if (selStart >= 0) {
      const snippetStart = Math.max(0, selStart - 60);
      const snippetEnd = Math.min(fullText.length, selStart + selectedText.length + 60);
      const before = fullText.slice(snippetStart, selStart);
      const after = fullText.slice(selStart + selectedText.length, snippetEnd);
      contextSnippet = `${snippetStart > 0 ? '…' : ''}${before}【${selectedText}】${after}${snippetEnd < fullText.length ? '…' : ''}`;
    }

    sel.removeAllRanges();

    setModalState({
      isOpen: true,
      selectedText,
      initialComment: '',
      annotationId: crypto.randomUUID(),
      pendingRangeInfo: rangeInfo,
      pendingContextSnippet: contextSnippet,
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
      pendingRangeInfo: ann.rangeInfo ?? null,
      pendingContextSnippet: ann.contextSnippet ?? '',
      mode: 'edit',
    });
  }

  function handleSave(ann: InlineAnnotation) {
    onAnnotationSave({
      ...ann,
      rangeInfo: modalState.pendingRangeInfo ?? ann.rangeInfo,
      contextSnippet: modalState.pendingContextSnippet || ann.contextSnippet,
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
        onSave={handleSave}
        onRemove={onAnnotationRemove}
        selectedText={modalState.selectedText}
        initialComment={modalState.initialComment}
        annotationId={modalState.annotationId}
        mode={modalState.mode}
      />
    </>
  );
}
