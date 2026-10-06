import { chmodSync, closeSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const DEFAULT_FS = { chmodSync, closeSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeFileSync };

/** The mode the written file gets: an existing file keeps its own (so a user's chmod 600
 *  survives a rewrite), and a new one gets `newMode`: private to its owner (0600) unless the
 *  caller passes null for the system default (an output file the user will publish). Windows
 *  keeps its default, since POSIX mode bits don't apply there. */
function modeFor(path, fs, newMode) {
  if (process.platform === 'win32') return undefined;
  const stat = fs.statSync ?? statSync;
  try {
    return stat(path).mode & 0o777;
  } catch {
    return newMode ?? undefined;
  }
}

export function atomicWriteText(path, content, fs = DEFAULT_FS, { newMode = 0o600 } = {}) {
  const temp = join(dirname(path), `${basename(path)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const mode = modeFor(path, fs, newMode);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    // The umask can only narrow the mode open() was given; set it outright so an existing
    // file's looser or tighter mode carries over exactly.
    if (mode !== undefined) (fs.chmodSync ?? chmodSync)(temp, mode);
    fs.renameSync(temp, path);
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(temp); } catch {}
    throw err;
  }
}

export function atomicWriteJson(path, value, fs) {
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`, fs);
}
