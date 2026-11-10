import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpecStore } from '../dist/core/spec-store.js';
import { SpecFileSchema } from '../dist/core/schemas.js';
import { restoreLegacyCompletion } from '../dist/core/legacy-completion.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const positional = args.filter((arg) => arg !== '--apply');
if (positional.length < 2) throw new Error('Usage: node scripts/restore-legacy-completion.mjs <repo> <ticket...> [--apply]');
const repo = resolve(positional[0]);
const tickets = [...new Set(positional.slice(1))];
for (const ticket of tickets) if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ticket)) throw new Error('Invalid ticket ID.');
const store = new SpecStore();
const backupDirectory = join(repo, '.specflow', 'backups', 'legacy-completion-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
const readOriginal = async (ticket) => {
  const bytes = await fs.readFile(join(repo, '.specflow', 'specs', ticket + '.json'), 'utf8');
  const spec = SpecFileSchema.parse(JSON.parse(bytes));
  return { bytes, spec, restored: restoreLegacyCompletion(spec) };
};
// Validate the full requested batch before changing any ticket.
for (const ticket of tickets) await readOriginal(ticket);
for (const ticket of tickets) {
  const original = await readOriginal(ticket);
  if (apply) {
    await store.transaction(repo, ticket, async () => {
      const current = await readOriginal(ticket);
      await fs.mkdir(backupDirectory, { recursive: true });
      await fs.writeFile(join(backupDirectory, ticket + '.json'), current.bytes, { flag: 'wx' });
      return { ...current.restored, updatedAt: new Date().toISOString() };
    });
  }
  console.log(JSON.stringify({ ticket, mode: apply ? 'applied' : 'preview',
    before: { schemaVersion: original.spec.schemaVersion, stage: original.spec.currentStageId, status: original.spec.execution.status },
    after: { stage: original.restored.currentStageId, status: original.restored.execution.status,
      completedTasks: original.restored.stages[3].subtasks?.filter((task) => task.completed).length ?? 0 },
    originalCompletedAt: original.restored.legacyCompletion.completedAt,
    ...(apply ? { backupDirectory } : {}) }));
}
