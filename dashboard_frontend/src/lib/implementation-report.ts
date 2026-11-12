/** Presentation only: approvals always use the immutable report ID and server validation. */
export function taskTitle(task: { title?: string; description: string }): string {
  const text = (task.title?.trim() || task.description.trim()).split(/\n|。|；|\.\s/)[0];
  const chars = Array.from(text);
  return chars.length > 48 ? chars.slice(0, 48).join('') + '…' : text;
}

type Section = { title: string; content: string };
const openingFence = (line: string) => /^ {0,3}([\u0060]{3,}|~{3,})(.*)$/.exec(line);
const closesFence = (line: string, fence: string) => line.trim().length >= fence.length && [...line.trim()].every(char => char === fence[0]);

export function presentImplementationReport(content: string) {
  const empty = { summary: content, sections: [] as Section[], files: [] as string[], statistics: { linesAdded: 0, linesRemoved: 0 } };
  if (!content.startsWith('# Implementation review: ')) return empty;
  const sections: Section[] = [{ title: '', content: '' }];
  let fence = '';
  for (const line of content.split('\n')) {
    if (fence) {
      sections.at(-1)!.content += line + '\n';
      if (closesFence(line, fence)) fence = '';
      continue;
    }
    const opening = openingFence(line);
    if (opening) fence = opening[1];
    if (!fence && line.startsWith('## ')) sections.push({ title: line.slice(3), content: '' });
    else sections.at(-1)!.content += line + '\n';
  }
  const intro = sections.shift()!.content
    .replace(/^# Implementation review: [^\n]*(?:\n|$)/, '').trimStart()
    .replace(/^Source fingerprint: [^\n]*(?:\n|$)/, '').trimStart()
    .replace(/^Plan revision and task attempt are recorded with this report\.(?:\n|$)/, '').trimStart();
  const lines = intro.split('\n');
  const visible: string[] = [];
  const files = new Set<string>();
  const statistics = { linesAdded: 0, linesRemoved: 0 };
  for (let i = 0; i < lines.length; i++) {
    const opening = openingFence(lines[i]);
    if (!opening) { visible.push(lines[i]); continue; }
    let end = i + 1;
    while (end < lines.length && !closesFence(lines[end], opening[1])) end++;
    const block = lines.slice(i, Math.min(end + 1, lines.length));
    let isLog = false;
    if (opening[2].trim() === 'json' && end < lines.length) {
      try {
        const value = JSON.parse(lines.slice(i + 1, end).join('\n'));
        isLog = typeof value.subtaskId === 'string' && typeof value.summary === 'string' && Array.isArray(value.filesModified) && Array.isArray(value.filesCreated);
        if (isLog) {
          for (const file of [...value.filesModified, ...value.filesCreated]) if (typeof file === 'string') files.add(file);
          for (const key of ['linesAdded', 'linesRemoved'] as const) if (Number.isFinite(value.statistics?.[key]) && value.statistics[key] >= 0) statistics[key] += value.statistics[key];
        }
      } catch { /* Unknown JSON stays visible; never hide unrecognized report content. */ }
    }
    if (!isLog) visible.push(...block);
    i = end;
  }
  return { summary: visible.join('\n').trim(), sections: sections.map(section => ({ ...section, content: section.content.trim() })), files: [...files], statistics };
}
