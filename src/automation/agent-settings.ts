import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentSettingsSchema, type AgentSettings, type AgentProfile } from '../core/agent-profile.js';

export class AgentSettingsStore {
  constructor(private home?: string) {}
  private directory() { return this.home ?? process.env.AI_PILOT_HOME ?? join(homedir(), '.specflow'); }
  async load(): Promise<AgentSettings> {
    try { return AgentSettingsSchema.parse(JSON.parse(await fs.readFile(join(this.directory(), 'agents.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return AgentSettingsSchema.parse({}); throw error; }
  }
  async save(input: unknown): Promise<AgentSettings> {
    const next = AgentSettingsSchema.parse(input);
    const directory = this.directory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, 'agents.json');
    const lockPath = target + '.lock';
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(await fs.readFile(lockPath, 'utf8').catch(() => ''));
      if (Number.isInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') await fs.unlink(lockPath).catch(() => {}); }
      }
      throw new Error('Agent settings are busy; reload and retry.');
    }
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await lock.writeFile(String(process.pid));
      const current = await this.load();
      if (next.revision !== current.revision) throw new Error('Settings changed. Reload the latest revision before saving.');
      next.revision++;
      next.profiles = next.profiles.map(profile => {
        const previous = current.profiles.find(item => item.id === profile.id);
        const changed = !previous || JSON.stringify({ ...profile, version: 0 }) !== JSON.stringify({ ...previous, version: 0 });
        return { ...profile, version: previous ? previous.version + Number(changed) : 1 };
      });
      await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await fs.rename(temporary, target);
      return next;
    } finally { await lock.close(); await fs.unlink(lockPath); await fs.unlink(temporary).catch(() => {}); }
  }
  async resolve(repoId: string, profileId?: string): Promise<AgentProfile> {
    const settings = await this.load();
    const id = profileId ?? settings.repoDefaults[repoId] ?? settings.defaultProfileId;
    const profile = settings.profiles.find(item => item.id === id);
    if (!profile) throw new Error('Choose an Agent profile in Settings before starting automatic execution.');
    return structuredClone(profile);
  }
}
