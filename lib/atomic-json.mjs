import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const DEFAULT_FS = { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync };

export function atomicWriteText(path, content, fs = DEFAULT_FS) {
  const temp = join(dirname(path), `${basename(path)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
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
