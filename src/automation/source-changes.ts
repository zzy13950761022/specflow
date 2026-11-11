import { promises as fs } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { z } from 'zod';

const Changes = z.array(z.object({ path: z.string().min(1).max(1024), content: z.string().max(2 * 1024 * 1024).nullable() }).strict()).min(1).max(200);
export const sourceOutputSchema = {
  type: 'object', additionalProperties: false, required: ['summary', 'files'],
  properties: { summary: { type: 'string' }, files: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: ['string', 'null'] } } } } },
};
export async function applySourceChanges(workspace: string, input: unknown): Promise<void> {
  const files = Changes.parse(input);
  const names = new Set<string>();
  for (const file of files) {
    const parts = file.path.split('/');
    if (isAbsolute(file.path) || file.path.includes(String.fromCharCode(92)) || parts.some(part => !part || part === '.' || part === '..' || ['.git', '.specflow', '.codex', '.claude', '.agents', 'node_modules'].includes(part))) throw new Error('Invalid source change path: ' + file.path);
    if (names.has(file.path.toLowerCase())) throw new Error('Duplicate source change path.');
    names.add(file.path.toLowerCase());
    for (let i = 1; i <= parts.length; i++) {
      const stat = await fs.lstat(join(workspace, ...parts.slice(0, i))).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat?.isSymbolicLink()) throw new Error('Source change path traverses a symlink.');
      if (stat && (i === parts.length ? !stat.isFile() : !stat.isDirectory())) throw new Error('Source change path is not a regular file.');
    }
  }
  for (const path of names) if ([...names].some(other => other.startsWith(path + '/'))) throw new Error('Conflicting source change paths.');
  for (const file of files) {
    const path = join(workspace, file.path);
    if (file.content === null) await fs.unlink(path);
    else { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, file.content); }
  }
}
