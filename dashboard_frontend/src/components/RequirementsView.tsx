import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AffectedFile, ReqItem, RequirementsData } from '../types';

/**
 * Legacy (pre-flat) affected-files shape: a nested tree the model used to emit
 * directly. Still found in already-saved artifacts. A node's `name` may itself
 * contain slashes. We flatten it back to full file paths and feed the same
 * tree builder, so old and new artifacts render identically.
 */
interface LegacyTreeNode {
  name: string;
  type?: 'dir' | 'file';
  impact?: string;
  children?: LegacyTreeNode[];
}

/** Requirements data as it may appear on disk: new flat form or legacy tree. */
type RequirementsDataLike = RequirementsData & {
  /** Legacy field — present only in artifacts written before the flat format. */
  affectedTree?: LegacyTreeNode[];
};

/**
 * Normalize either shape to the flat AffectedFile[] the tree builder consumes:
 *  - new format: return affectedFiles as-is;
 *  - legacy format: walk affectedTree, joining ancestor names to each leaf to
 *    reconstruct full paths. A node is a leaf when it has no children; its
 *    `impact` travels with it. buildTree then re-merges shared directories and
 *    preserves the author's nesting wherever it is genuinely shared.
 */
export function toAffectedFiles(data: RequirementsDataLike): AffectedFile[] {
  if (data.affectedFiles?.length) return data.affectedFiles;
  const tree = data.affectedTree;
  if (!tree?.length) return data.affectedFiles ?? [];

  const out: AffectedFile[] = [];
  const walk = (node: LegacyTreeNode, prefix: string) => {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.children?.length) {
      for (const child of node.children) walk(child, path);
    } else {
      // Leaf — a file (or a dir the author left childless; treat as a row).
      out.push({ path, impact: node.impact });
    }
  };
  for (const n of tree) walk(n, '');
  return out;
}

/**
 * Rich Requirements-stage view (Phase 5). Renders the structured requirementsData
 * sidecar as:
 *   - an affected-files tree-table (Path | Impact) with VSCode-style folder/file
 *     icons. The model returns a FLAT list of file paths (legacy artifacts used a
 *     nested tree — see toAffectedFiles); this component builds the directory
 *     tree, merging shared directories, compacting single-child chains (VSCode
 *     "compact folders"), forcing top-level dir groups (src deepens to src/<sub>),
 *     and sorting dirs-first then files. Directories are collapsible via a ▶/▼ chevron;
 *   - a four-quadrant grid: reuse | build-from-scratch / data-migration | integrations,
 *     each with its own accent border.
 * The raw markdown summary stays available under a collapsible <details>.
 *
 * When `data` is missing (an older markdown-only requirements artifact), the
 * caller falls back to plain markdown — this component assumes `data` is present.
 */
export function RequirementsView({
  data,
  content,
}: {
  data: RequirementsDataLike;
  content: string;
}) {
  return (
    <div className="flex flex-col gap-5">
      {/* Row 1 — affected files tree-table */}
      <section>
        <SectionTitle>Which parts of the system are affected</SectionTitle>
        <TreeTable files={toAffectedFiles(data)} />
      </section>

      {/* Rows 2–3 — four-quadrant grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <QuadrantCard
          title="Existing functionality we can reuse"
          accent="emerald"
          items={data.reuse}
        />
        <QuadrantCard
          title="What needs to be built from scratch"
          accent="purple"
          items={data.buildFromScratch}
        />
        <QuadrantCard
          title="Data migration requirements"
          accent="blue"
          items={data.dataMigration}
        />
        <QuadrantCard
          title="Integration touchpoints"
          accent="amber"
          items={data.integrations}
        />
      </div>

      {/* Raw markdown fallback */}
      <details className="text-sm">
        <summary className="cursor-pointer text-slate-500 hover:text-gray-800">
          Raw markdown
        </summary>
        <div className="md-body mt-3">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </details>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </h3>
  );
}

/* ---------- Tree table ---------- */

/** Render-time tree node, derived from the flat affectedFiles list. */
interface TreeNode {
  /** Display label — may be a compacted multi-segment path like 'version-detail/version-detail-page'. */
  name: string;
  type: 'dir' | 'file';
  impact?: string;
  children?: TreeNode[];
}

/**
 * Build a directory tree from a flat list of file paths:
 *  - split each path on '/', creating intermediate dir nodes;
 *  - merge siblings that share a directory name (so two 'shared/…' files land
 *    under one 'shared/' folder), at every level including the root;
 *  - compact single-child directory chains into one row (VSCode "compact
 *    folders"): a dir with exactly one child joins its name to that child, so a
 *    path no sibling shares renders as a single row (e.g.
 *    'service/plugin-service.service.ts'). Splitting only appears where a
 *    directory is genuinely shared.
 *  - ROOT BOUNDARY: top-level nodes are forced to a directory and never compact
 *    across their boundary — the boundary is 1 segment deep, or 2 for 'src'
 *    (so first-level groups read like 'src/app', 'src/assets', 'playwright').
 *    A file sitting directly at the repo root (e.g. 'package.json') is the one
 *    exception: it stays a bare file row.
 *  - sort each level dirs-first, then files, alphabetically.
 */
export function buildTree(files: AffectedFile[]): TreeNode[] {
  interface Build {
    name: string;
    children: Map<string, Build>;
    isFile: boolean;
    impact?: string;
  }
  const root: Build = { name: '', children: new Map(), isFile: false };

  for (const f of files) {
    const segments = f.path.split('/').filter(Boolean);
    if (!segments.length) continue;
    let cur = root;
    segments.forEach((seg, i) => {
      const isLast = i === segments.length - 1;
      let next = cur.children.get(seg);
      if (!next) {
        next = { name: seg, children: new Map(), isFile: false };
        cur.children.set(seg, next);
      }
      if (isLast) {
        next.isFile = true;
        next.impact = f.impact;
      }
      cur = next;
    });
  }

  /**
   * Convert a build-node to a render node.
   *
   * `boundary` is the number of leading path segments (of THIS node's own path,
   * excluding `prefix`) that must be emitted as a forced top-level directory
   * before normal compaction resumes. 0 means no boundary — pure VSCode
   * "compact folders" (absorb single-child chains until a shared dir or file).
   *
   * `prefix` is an ancestor path glued in front of the emitted first-level name
   * (used to render each child of 'src' as 'src/<child>').
   *
   * At the root we pass boundary=1 for a top-level dir (→ 'playwright'); for the
   * children of 'src' we pass boundary=1 with prefix='src' (→ 'src/app').
   * Everything deeper is called with boundary=0.
   */
  const toNode = (b: Build, boundary: number, prefix?: string): TreeNode => {
    const withPrefix = (name: string) => (prefix ? `${prefix}/${name}` : name);
    let node = b;
    const nameParts = [b.name];

    if (boundary > 0) {
      // Phase 1: absorb exactly up to the boundary (forced), even past shared
      // dirs, so the first-level group is e.g. 'src/app' or 'playwright'. Stop
      // early only if the path genuinely ends before the boundary.
      while (nameParts.length < boundary && node.children.size >= 1 && !node.isFile) {
        const only = node.children.size === 1 ? [...node.children.values()][0] : null;
        if (!only) break; // a shared dir before the boundary — can't absorb further
        nameParts.push(only.name);
        node = only;
      }
      // Emit the boundary node as a directory. Its children render with normal
      // compaction (boundary 0). If the boundary landed on a file leaf, split
      // the leaf out so it reads 'dir' ▸ 'file' (e.g. 'src/main.ts' → 'src' ▸
      // 'main.ts'; with prefix='src' the dir is just the prefix).
      if (node.isFile && node.children.size === 0) {
        const dirName = nameParts.length > 1 ? withPrefix(nameParts.slice(0, -1).join('/')) : prefix;
        const fileLeaf = nameParts[nameParts.length - 1];
        if (dirName) {
          return {
            name: dirName,
            type: 'dir',
            children: [{ name: fileLeaf, type: 'file', impact: node.impact }],
          };
        }
        // No prefix and single segment — shouldn't happen for a dir boundary,
        // but fall through to a bare file row defensively.
        return { name: withPrefix(fileLeaf), type: 'file', impact: node.impact };
      }
      const children = [...node.children.values()].map((c) => toNode(c, 0));
      return {
        name: withPrefix(nameParts.join('/')),
        type: 'dir',
        children: children.length ? sortNodes(children) : undefined,
      };
    }

    // boundary === 0: normal VSCode compaction.
    while (!node.isFile && node.children.size === 1) {
      const only = [...node.children.values()][0];
      nameParts.push(only.name);
      node = only;
    }
    const children = [...node.children.values()].map((c) => toNode(c, 0));
    return {
      name: withPrefix(nameParts.join('/')),
      type: node.isFile && node.children.size === 0 ? 'file' : 'dir',
      impact: node.isFile ? node.impact : undefined,
      children: children.length ? sortNodes(children) : undefined,
    };
  };

  // Top-level grouping with the root boundary:
  //  - a file directly at the repo root (e.g. 'package.json') stays a bare row;
  //  - 'src' is NOT a group on its own — it deepens so each 'src/<sub>' is its
  //    own first-level node (src/app, src/assets, …), and a file directly under
  //    src (src/main.ts) becomes a forced 'src' ▸ 'main.ts' node;
  //  - any other top-level directory groups at its first segment ('playwright').
  const top: TreeNode[] = [];
  for (const b of [...root.children.values()]) {
    if (b.isFile && b.children.size === 0) {
      top.push(toNode(b, 0)); // root-level file → bare row
    } else if (b.name === 'src') {
      // Expand src one level: each child becomes a 'src/<child>' first-level node.
      for (const sub of [...b.children.values()]) {
        top.push(toNode(sub, 1, 'src'));
      }
    } else {
      top.push(toNode(b, 1));
    }
  }
  return sortNodes(top);
}

/** Dirs first, then files; alphabetical within each group. */
function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function TreeTable({ files }: { files: AffectedFile[] }) {
  if (!files.length) {
    return <EmptyNote>No affected files recorded.</EmptyNote>;
  }
  const nodes = buildTree(files);
  return (
    <div className="overflow-hidden rounded-xl border border-white/10">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2 font-medium">Path</th>
            <th className="px-3 py-2 font-medium">Impact</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node, i) => (
            <TreeRows key={i} node={node} depth={0} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Recursively renders a node row plus its descendant rows. Directories are
 * collapsible (default expanded): a ▶/▼ chevron toggles the children, VSCode-style.
 */
function TreeRows({ node, depth }: { node: TreeNode; depth: number }) {
  const isDir = node.type === 'dir';
  const hasChildren = isDir && !!node.children?.length;
  const [open, setOpen] = useState(true);

  return (
    <>
      <tr className="border-t border-white/5 hover:bg-white/5">
        <td className="px-3 py-1.5">
          <span
            style={{ paddingLeft: `${depth * 1.25}rem` }}
            className={`inline-flex items-center gap-1.5 ${hasChildren ? 'cursor-pointer select-none' : ''}`}
            onClick={hasChildren ? () => setOpen((o) => !o) : undefined}
          >
            {/* chevron: only directories with children get one; files/empty dirs get a spacer */}
            <span className="inline-flex w-3.5 justify-center text-slate-500">
              {hasChildren ? <Chevron open={open} /> : null}
            </span>
            <span className="inline-flex w-4 justify-center">
              {isDir ? <FolderIcon open={open} /> : <FileIcon />}
            </span>
            <span className={isDir ? 'font-medium text-gray-800' : 'text-gray-700'}>
              {node.name}
            </span>
          </span>
        </td>
        {/* Directory rows leave Impact blank. */}
        <td className="px-3 py-1.5 text-slate-500">{isDir ? '' : node.impact ?? ''}</td>
      </tr>
      {hasChildren &&
        open &&
        node.children!.map((child, i) => <TreeRows key={i} node={child} depth={depth + 1} />)}
    </>
  );
}

/* ---------- VSCode-style tree icons (inline SVG, no extra deps) ---------- */

function Chevron({ open }: { open: boolean }) {
  // ▶ when collapsed, ▼ when expanded (a right chevron rotated 90°).
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      className={`transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  // VSCode-ish folder: a tabbed folder outline, lid lifted when open.
  return open ? (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden className="text-joule-blue">
      <path
        d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3l1 1.2H13.5a1 1 0 0 1 1 1V6H3.6a1 1 0 0 0-.95.68L1.5 10.2V3.5Z"
        fill="currentColor"
        fillOpacity="0.25"
      />
      <path
        d="M1.9 12.5h10.3a1 1 0 0 0 .95-.68l1.3-4.2a.6.6 0 0 0-.57-.78H4.1a1 1 0 0 0-.95.68L1.5 12a.4.4 0 0 0 .4.5Z"
        fill="currentColor"
        fillOpacity="0.5"
        stroke="currentColor"
        strokeWidth="0.8"
      />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden className="text-joule-blue">
      <path
        d="M1.5 4.5a1 1 0 0 1 1-1h3l1 1.2h6a1 1 0 0 1 1 1v5.8a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V4.5Z"
        fill="currentColor"
        fillOpacity="0.4"
        stroke="currentColor"
        strokeWidth="0.8"
      />
    </svg>
  );
}

function FileIcon() {
  // VSCode-ish document with a folded corner.
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden className="text-slate-500">
      <path
        d="M4 1.5h5L13 5.5v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="0.9"
      />
      <path d="M9 1.5V5.5H13" stroke="currentColor" strokeWidth="0.9" fill="none" />
    </svg>
  );
}

/* ---------- Quadrant cards ---------- */

type Accent = 'emerald' | 'purple' | 'blue' | 'amber';

const ACCENTS: Record<
  Accent,
  { border: string; bg: string; dot: string; title: string; badge: string; itemBg: string }
> = {
  emerald: {
    border: 'border-emerald-200',
    bg: 'bg-emerald-50',
    dot: 'bg-emerald-500',
    title: 'text-emerald-800',
    badge: 'bg-emerald-100 text-emerald-700',
    itemBg: 'bg-white border border-emerald-100',
  },
  purple: {
    border: 'border-violet-200',
    bg: 'bg-violet-50',
    dot: 'bg-violet-500',
    title: 'text-violet-800',
    badge: 'bg-violet-100 text-violet-700',
    itemBg: 'bg-white border border-violet-100',
  },
  blue: {
    border: 'border-blue-200',
    bg: 'bg-blue-50',
    dot: 'bg-blue-500',
    title: 'text-blue-800',
    badge: 'bg-blue-100 text-blue-700',
    itemBg: 'bg-white border border-blue-100',
  },
  amber: {
    border: 'border-amber-200',
    bg: 'bg-amber-50',
    dot: 'bg-amber-500',
    title: 'text-amber-800',
    badge: 'bg-amber-100 text-amber-700',
    itemBg: 'bg-white border border-amber-100',
  },
};

function QuadrantCard({
  title,
  accent,
  items,
}: {
  title: string;
  accent: Accent;
  items: ReqItem[];
}) {
  const a = ACCENTS[accent];
  return (
    <div className={`rounded-xl border ${a.border} ${a.bg} p-4 flex flex-col gap-3`}>
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${a.dot}`} aria-hidden />
        <h3 className={`text-sm font-semibold flex-1 ${a.title}`}>{title}</h3>
        <span className={`text-[11px] font-medium rounded-full px-2 py-0.5 ${a.badge}`}>
          {items.length}
        </span>
      </div>
      {items.length ? (
        <ul className="flex flex-col gap-2">
          {items.map((item, i) => (
            <li key={i} className={`rounded-lg px-3 py-2 ${a.itemBg}`}>
              <div className="text-sm font-medium text-gray-800">{item.title}</div>
              {item.detail && (
                <div className="mt-0.5 text-[12px] text-slate-500 leading-relaxed">{item.detail}</div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyNote>None.</EmptyNote>
      )}
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] italic text-slate-500">{children}</p>;
}
