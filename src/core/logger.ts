/**
 * Invariant #1: stdout carries ONLY MCP JSON-RPC frames.
 * Every log line goes to stderr. This module is imported first in the entry
 * point and installs a runtime guard that redirects any stray console.log to
 * stderr, so an accidental console.log cannot corrupt the protocol stream.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, args: unknown[]): void {
  const ts = new Date().toISOString();
  const parts = args.map((a) =>
    typeof a === 'string' ? a : safeStringify(a)
  );
  // Always stderr. Never process.stdout.
  process.stderr.write(`[${ts}] ${level.toUpperCase()} ${parts.join(' ')}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  debug: (...args: unknown[]) => write('debug', args),
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
};

/**
 * Redirect console.log / console.info to stderr so a stray call cannot write
 * to stdout. Call once at process start, before any transport is wired.
 */
export function installStdoutGuard(): void {
  const toStderr =
    (level: Level) =>
    (...args: unknown[]) =>
      write(level, args);

  console.log = toStderr('info');
  console.info = toStderr('info');
  console.debug = toStderr('debug');
  console.warn = toStderr('warn');
  console.error = toStderr('error');
}
