import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { presentImplementationReport } from '../lib/implementation-report';

export function ImplementationReportContent({ content }: { content: string }) {
  const report = useMemo(() => presentImplementationReport(content), [content]);
  const hasDiff = report.sections.some(section => section.title === 'Tracked source diff');
  return <div className="implementation-content">
    {report.summary && <section><h3>Implementation summary</h3><div className="md-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{report.summary}</ReactMarkdown></div></section>}
    {report.sections.length > 0 && <section>
      <div className="implementation-section-heading"><h3>File changes</h3><span>{report.files.length || report.sections.filter(section => section.title.startsWith('Current source:')).length} files <b className="text-emerald-700">+{report.statistics.linesAdded}</b> <b className="text-red-600">−{report.statistics.linesRemoved}</b></span></div>
      {report.sections.map((section, index) => <details key={index} className="implementation-file" open={!hasDiff || !section.title.startsWith('Current source:')}>
        <summary>{section.title === 'Tracked source diff' ? 'Tracked changes' : section.title.replace('Current source: ', '')}{section.title.startsWith('Current source:') && <span>Source snapshot</span>}</summary>
        <div className="md-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code({ className, children, ...props }) {
          if (className === 'language-diff') return <code className="implementation-diff">{String(children).split('\n').map((line, i) => <span key={i} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line || ' '}</span>)}</code>;
          return <code className={className} {...props}>{children}</code>;
        } }}>{section.content}</ReactMarkdown></div>
      </details>)}
    </section>}
    <details className="implementation-technical"><summary>Technical details · original report, fingerprint and logs</summary><pre>{content}</pre></details>
  </div>;
}
