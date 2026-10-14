import { execFile } from 'child_process';
import { platform } from 'os';

/**
 * Opens a native OS folder-chooser and resolves to the selected absolute path,
 * or null if the user cancelled. This runs in the Node process (not the
 * browser) because the browser sandbox cannot read a folder's real filesystem
 * path. macOS only for now via AppleScript; other platforms throw a clear error.
 */
export function pickFolder(): Promise<string | null> {
  if (platform() !== 'darwin') {
    return Promise.reject(
      new Error('Native folder picker is only supported on macOS. Type the path instead.')
    );
  }

  // AppleScript: show a "choose folder" dialog, print its POSIX path.
  const script =
    'try\n' +
    '  set f to choose folder with prompt "Select a repository folder"\n' +
    '  return POSIX path of f\n' +
    'on error number -128\n' + // -128 == user cancelled
    '  return ""\n' +
    'end try';

  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err, stdout) => {
      if (err) return reject(err);
      const path = stdout.trim();
      resolve(path.length > 0 ? path : null);
    });
  });
}
