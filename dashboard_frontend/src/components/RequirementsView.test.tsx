import { describe, it, expect } from 'vitest';
import { buildTree, toAffectedFiles } from './RequirementsView';
import type { AffectedFile } from '../types';

/**
 * Unit tests for buildTree — the flat-file-list → directory-tree builder that
 * backs the Requirements affected-files view. It must: split paths, merge
 * directories shared by siblings (at every level incl. root), compact
 * single-child chains VSCode-style, and sort dirs-first then files.
 */

// Compact serializer: "name" for a file, "name/[children]" for a dir, so a
// whole tree reads as one assertable string.
function serialize(nodes: ReturnType<typeof buildTree>): string {
  return nodes
    .map((n) =>
      n.type === 'dir' ? `${n.name}/[${serialize(n.children ?? [])}]` : n.name
    )
    .join(',');
}

describe('buildTree', () => {
  it('returns an empty array for no files', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('merges a directory shared by multiple files under one node', () => {
    const files: AffectedFile[] = [
      { path: 'src/app/shared/a.ts' },
      { path: 'src/app/shared/b.ts' },
    ];
    // 'src/app' is the forced first-level boundary; below it 'shared' holds the
    // two merged files.
    expect(serialize(buildTree(files))).toBe('src/app/[shared/[a.ts,b.ts]]');
  });

  it('compacts a single-child chain BELOW the root boundary into one row', () => {
    const files: AffectedFile[] = [{ path: 'src/app/service/plugin.service.ts' }];
    // Root boundary forces 'src/app' as a dir; below it the single-child chain
    // compacts to one file row.
    expect(serialize(buildTree(files))).toBe('src/app/[service/plugin.service.ts]');
  });

  it('forces a top-level directory even when the whole path is unshared', () => {
    // 'playwright' is a top-level dir → boundary 1 segment; the file below it
    // compacts but 'playwright' stays its own folder node.
    expect(serialize(buildTree([{ path: 'playwright/CXMC-1 spec' }]))).toBe(
      'playwright/[CXMC-1 spec]'
    );
  });

  it('deepens src to two segments (src/app, src/assets)', () => {
    const files: AffectedFile[] = [
      { path: 'src/app/x.ts' },
      { path: 'src/assets/i18n/en.json' },
    ];
    // 'src' is NOT a top-level group on its own — it deepens to src/app and
    // src/assets, each a separate first-level node.
    expect(serialize(buildTree(files))).toBe(
      'src/app/[x.ts],src/assets/[i18n/en.json]'
    );
  });

  it('forces a src/ folder even for a file directly under src', () => {
    // src/main.ts has no second-level dir, but the boundary still forces
    // 'src' ▸ 'main.ts' rather than a bare 'src/main.ts' row.
    expect(serialize(buildTree([{ path: 'src/main.ts' }]))).toBe('src/[main.ts]');
  });

  it('keeps a file directly at the repo root as a bare row', () => {
    expect(serialize(buildTree([{ path: 'package.json' }]))).toBe('package.json');
  });

  it('splits only where a directory is genuinely shared', () => {
    const files: AffectedFile[] = [
      { path: 'src/app/shared/provider/P.ts' },
      { path: 'src/app/shared/pipes/E.ts' },
      { path: 'src/app/service/plugin.service.ts' },
    ];
    // 'src/app' is the forced first-level group. Under it: 'shared' is shared by
    // two entries (splits), 'service/...' is not (stays compact). Dirs before files.
    expect(serialize(buildTree(files))).toBe(
      'src/app/[shared/[pipes/E.ts,provider/P.ts],service/plugin.service.ts]'
    );
  });

  it('merges shared directories at the ROOT level across separate entries', () => {
    const files: AffectedFile[] = [
      { path: 'src/core/order.ts' },
      { path: 'src/api/checkout.ts' },
    ];
    // src deepens → two separate first-level groups src/api and src/core.
    expect(serialize(buildTree(files))).toBe(
      'src/api/[checkout.ts],src/core/[order.ts]'
    );
  });

  it('sorts directories before files, each alphabetically', () => {
    const files: AffectedFile[] = [
      { path: 'root/zebra.ts' },
      { path: 'root/alpha/one.ts' },
      { path: 'root/alpha/two.ts' },
      { path: 'root/beta/x.ts' },
      { path: 'root/apple.ts' },
    ];
    // Under 'root': 'alpha' has two children so it stays a dir and sorts first.
    // 'beta/x.ts' has a single child, so it compacts into a FILE row named
    // 'beta/x.ts' — it sorts among the files (apple.ts, beta/x.ts, zebra.ts).
    expect(serialize(buildTree(files))).toBe(
      'root/[alpha/[one.ts,two.ts],apple.ts,beta/x.ts,zebra.ts]'
    );
  });

  it('keeps impact only on file leaves, not directory rows', () => {
    const tree = buildTree([
      { path: 'src/app/shared/a.ts', impact: 'change A' },
      { path: 'src/app/shared/b.ts', impact: 'change B' },
    ]);
    // 'src/app' forced boundary dir → 'shared' dir → two file leaves.
    const srcApp = tree[0];
    expect(srcApp).toMatchObject({ name: 'src/app', type: 'dir' });
    expect(srcApp.impact).toBeUndefined();
    const shared = srcApp.children![0];
    expect(shared).toMatchObject({ name: 'shared', type: 'dir' });
    expect(shared.impact).toBeUndefined();
    const [a, b] = shared.children!;
    expect(a).toMatchObject({ name: 'a.ts', type: 'file', impact: 'change A' });
    expect(b).toMatchObject({ name: 'b.ts', type: 'file', impact: 'change B' });
  });

  it('tolerates leading/trailing/duplicate slashes', () => {
    const files: AffectedFile[] = [
      { path: '/src/app/x.ts' },
      { path: 'src/app//y.ts' },
    ];
    // Empty segments are dropped; both land under the shared src/app dir.
    expect(serialize(buildTree(files))).toBe('src/app/[x.ts,y.ts]');
  });

  it('handles a single top-level file with no directory', () => {
    expect(serialize(buildTree([{ path: 'README.md' }]))).toBe('README.md');
  });
});

describe('toAffectedFiles (legacy affectedTree compatibility)', () => {
  it('returns the flat affectedFiles list unchanged when present', () => {
    const files: AffectedFile[] = [{ path: 'src/app/x.ts', impact: 'a' }];
    expect(toAffectedFiles({ affectedFiles: files } as never)).toEqual(files);
  });

  it('flattens a legacy nested tree into full paths, joining ancestor names', () => {
    const legacy = {
      affectedTree: [
        {
          name: 'src/app',
          type: 'dir',
          children: [
            {
              name: 'shared/components/create-extension-dialog',
              type: 'dir',
              children: [
                { name: 'create-extension-dialog.component.ts', type: 'file', impact: 'I1' },
                { name: 'create-extension-dialog.component.html', type: 'file', impact: 'I2' },
              ],
            },
            { name: 'shared/provider/PluginExtensionProvider.ts', type: 'file', impact: 'I3' },
          ],
        },
        { name: 'src/mock-apis/db.json', type: 'file', impact: 'I4' },
      ],
    };
    expect(toAffectedFiles(legacy as never)).toEqual([
      { path: 'src/app/shared/components/create-extension-dialog/create-extension-dialog.component.ts', impact: 'I1' },
      { path: 'src/app/shared/components/create-extension-dialog/create-extension-dialog.component.html', impact: 'I2' },
      { path: 'src/app/shared/provider/PluginExtensionProvider.ts', impact: 'I3' },
      { path: 'src/mock-apis/db.json', impact: 'I4' },
    ]);
  });

  it('prefers the new flat form when BOTH fields are present', () => {
    const data = {
      affectedFiles: [{ path: 'new.ts' }],
      affectedTree: [{ name: 'old.ts', type: 'file' }],
    };
    expect(toAffectedFiles(data as never)).toEqual([{ path: 'new.ts' }]);
  });

  it('flattened legacy tree feeds buildTree to a merged, boundary-grouped tree', () => {
    // The real CXMC-66353 shape (abbreviated): a legacy tree where 'shared' is
    // split across an explicit dir node AND inline file paths — buildTree must
    // re-merge them under one 'shared' folder below the src/app boundary.
    const legacy = {
      affectedTree: [
        {
          name: 'src/app',
          type: 'dir',
          children: [
            {
              name: 'shared/components/create-extension-dialog',
              type: 'dir',
              children: [{ name: 'create-extension-dialog.component.ts', type: 'file' }],
            },
            { name: 'shared/provider/PluginExtensionProvider.ts', type: 'file' },
            { name: 'service/plugin-service.service.ts', type: 'file' },
          ],
        },
        { name: 'playwright', type: 'dir', children: [{ name: 'CXMC spec', type: 'file' }] },
      ],
    };
    const files = toAffectedFiles(legacy as never);
    // 'shared' appears once (merged); src/app is the forced boundary; playwright split out.
    expect(serialize(buildTree(files))).toBe(
      'playwright/[CXMC spec],' +
        'src/app/[' +
        'shared/[components/create-extension-dialog/create-extension-dialog.component.ts,provider/PluginExtensionProvider.ts],' +
        'service/plugin-service.service.ts' +
        ']'
    );
  });
});
