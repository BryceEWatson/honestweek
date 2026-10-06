// lib/windows-root.mjs: where Windows keeps its own programs.
//
// honestweek starts cmd.exe, taskkill.exe and rundll32.exe by their full path in the system
// folder, never by a bare name, so a file of that name in the current folder or early on the
// PATH is never the one run.

import { win32 } from 'node:path';

/** The Windows folder: SystemRoot, else windir, else C:\Windows. */
export function windowsRoot(env = process.env) {
  return env?.SystemRoot || env?.SYSTEMROOT || env?.windir || env?.WINDIR || 'C:\\Windows';
}

/** The full path of a program in the Windows system folder (System32). */
export function systemProgram(name, env = process.env) {
  return win32.join(windowsRoot(env), 'System32', name);
}
