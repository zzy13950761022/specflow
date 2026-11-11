import { expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applySourceChanges } from './source-changes.js';

it('validates all paths before writing and refuses symlink and canonical-state changes', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'source-edits-'));
  try {
    await expect(applySourceChanges(root, [{ path: 'good.ts', content: 'good' }, { path: '../escape', content: 'bad' }])).rejects.toThrow(/path/i);
    await expect(fs.stat(join(root, 'good.ts'))).rejects.toThrow();
    await expect(applySourceChanges(root, [{ path: '.specflow/specs/T-1.json', content: '{}' }])).rejects.toThrow(/path/i);
    await fs.symlink(tmpdir(), join(root, 'link'));
    await expect(applySourceChanges(root, [{ path: 'link/escape', content: 'bad' }])).rejects.toThrow(/symlink/i);
    await applySourceChanges(root, [{ path: 'src/feature.ts', content: 'export const feature = true;' }]);
    expect(await fs.readFile(join(root, 'src/feature.ts'), 'utf8')).toContain('feature = true');
    await applySourceChanges(root, [{ path: 'src/feature.ts', content: null }]);
    await expect(fs.stat(join(root, 'src/feature.ts'))).rejects.toThrow();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
