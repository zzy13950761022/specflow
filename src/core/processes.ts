export function processAlive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export function processGroupAlive(pid?: number): boolean {
  if (!pid) return false;
  if (processAlive(pid)) return true;
  if (process.platform === 'win32') return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
