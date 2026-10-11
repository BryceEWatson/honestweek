// lib/app-sessions.mjs: the Claude desktop app's own record of each Claude Code session it runs,
// read for three things: which Claude Code log it names, the title its sidebar shows, and
// whether you archived the session.
//
// The app keeps one small JSON file per session under its data folder, in
// claude-code-sessions/<account>/<workspace>/local_<id>.json. Each names the Claude Code log it
// writes (`cliSessionId`). honestweek reads `cliSessionId`, `title` and `isArchived` and nothing
// else from it: not the folders, tools, branches or summaries the file also holds. A file that
// can't be read or parsed (the app may be writing it) is skipped. Nothing is written.
//
// Zero runtime dependencies: Node built-ins only.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the desktop app keeps its session files on this platform, or null when it can't say. */
export function appSessionsRoot(env = process.env, platform = process.platform) {
  if (env.HONESTWEEK_APP_SESSIONS) return env.HONESTWEEK_APP_SESSIONS;
  if (platform === 'win32') return env.APPDATA ? join(env.APPDATA, 'Claude', 'claude-code-sessions') : null;
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Claude', 'claude-code-sessions');
}

const list = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/**
 * readAppSessions(root) -> Map<cliSessionId (lower case), { title, archived }>
 * Two folder levels down from `root`, every local_*.json file. Empty when the folder is absent.
 */
export function readAppSessions(root) {
  const out = new Map();
  if (!root) return out;
  for (const a of list(root)) {
    if (!a.isDirectory()) continue;
    for (const b of list(join(root, a.name))) {
      if (!b.isDirectory()) continue;
      const dir = join(root, a.name, b.name);
      for (const f of list(dir)) {
        if (!f.isFile() || !/^local_[A-Za-z0-9-]{1,80}\.json$/.test(f.name)) continue;
        const path = join(dir, f.name);
        let j;
        try {
          // A session file is a few kilobytes; one far larger isn't one.
          if (statSync(path).size > 4 * 1024 * 1024) continue;
          j = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          continue;
        }
        if (!j || typeof j.cliSessionId !== 'string') continue;
        out.set(j.cliSessionId.toLowerCase(), { title: typeof j.title === 'string' && j.title.trim() ? j.title.trim() : null, archived: j.isArchived === true });
      }
    }
  }
  return out;
}
