import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sep } from 'node:path';
const execute = promisify(execFile);

/** Paths are passed as arguments/environment values, never interpolated into scripts. */
export async function chooseFolder(start: string, title: string): Promise<string | null> {
  try {
    if (process.platform === 'darwin') {
      const script = `on run argv
  try
    set initialFolder to POSIX file (item 1 of argv)
    set dialogTitle to item 2 of argv
    tell application "Finder"
      activate
      set selectedFolder to choose folder with prompt dialogTitle default location initialFolder
    end tell
    return POSIX path of selectedFolder
  on error number -128
    return ""
  end try
end run`;
      const { stdout } = await execute('/usr/bin/osascript', ['-e', script, start, title], { timeout: 300_000 });
      return stdout.trim() || null;
    }
    if (process.platform === 'win32') {
      const script = `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = $env:CSYNC_DIALOG_TITLE
$d.SelectedPath = $env:CSYNC_DIALOG_START
try { if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write($d.SelectedPath) } } finally { $d.Dispose() }`;
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
        env: { ...process.env, CSYNC_DIALOG_TITLE: title, CSYNC_DIALOG_START: start }, timeout: 300_000,
      });
      return stdout.trim() || null;
    }
    const { stdout } = await execute('zenity', ['--file-selection', '--directory', '--filename', start + sep, '--title', title], { timeout: 300_000 });
    return stdout.trim() || null;
  } catch (error) {
    if (process.platform === 'linux' && (error as { code?: number }).code === 1) return null;
    throw new Error('폴더 다이얼로그를 열 수 없습니다. 경로를 직접 입력해 주세요. Linux에서는 zenity가 필요합니다.', { cause: error });
  }
}
