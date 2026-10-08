// lib/saved/saver.mjs: `honestweek view`'s side of saved results (issue 151). One for the whole
// run, so a Settings save that reloads the week keeps its state.
//
// It saves only while the config view read has "saveResults" on, and only into the folder beside
// that config: never in the demo, and never before setup. What it last did, or why it couldn't,
// is kept for Settings to show, in a few words with no path.
//
// Zero runtime dependencies: Node built-ins only.

import { CHECKS_SUB, saveChecks } from './checks.mjs';
import { loadSaved, saveHistory } from './history.mjs';
import { ensureGitignore } from '../init.mjs';
import { ensureSavedDir, forgetSaved, SAVED_GITIGNORE, savedDirOf, savedOptions, savedSize } from './store.mjs';

/**
 * createSaver({ configDir, config, demo, now }) -> { onChecked, load, info, forget }
 *   configDir()  the config's folder, or null when there's none to save beside
 *   config()     the normalized config this run reads
 */
export function createSaver({ configDir = () => null, config = () => null, demo = false, now = () => Date.now() } = {}) {
  // forgotAt: when Forget last ran. A build that began reading before it saves nothing, so a
  // save still pending when Forget is pressed can't bring the folder back.
  const state = { savedAt: null, days: 0, error: null, forgotAt: null };
  const dirOf = () => {
    const c = demo ? null : configDir();
    return typeof c === 'string' && c ? savedDirOf(c) : null;
  };

  /** The whole window's check results, from lib/view/data.mjs: saved when saving is on. */
  function onChecked({ h, builtT = null, result, keys, describeStep }) {
    const options = savedOptions(config());
    const dir = dirOf();
    if (!options || !dir) return null;
    if (state.forgotAt !== null && !(Number.isFinite(builtT) && builtT > state.forgotAt)) return null;
    try {
      ensureSavedDir(dir);
      ensureGitignore(configDir(), SAVED_GITIGNORE[0]);
      const out = saveChecks({ dir, config: config(), h, result, keys, describeStep, keepDays: options.keepDays, now: now() });
      if (options.history) saveHistory({ dir, config: config(), h, keepDays: options.keepDays, now: now() });
      state.savedAt = now();
      state.days = out.days.length;
      state.error = null;
      return out;
    } catch (err) {
      // The reason in a few words, with no path: a code such as EACCES says enough.
      state.error = err?.code ? `the folder couldn't be written (${err.code})` : "the folder couldn't be written";
      return null;
    }
  }

  /**
   * The saved sessions a window can show and their saved findings ({ sessions, findings }, as
   * loadSaved gives them), or null with saving or its history off, or nothing saved to read.
   */
  function load({ from, to, timezone, roots }) {
    const options = savedOptions(config());
    const dir = dirOf();
    if (!options?.history || !dir) return null;
    try {
      const out = loadSaved({ dir, from, to, timezone, roots });
      return out.sessions.length ? out : null;
    } catch {
      return null;
    }
  }

  /** What Settings shows: whether there's a folder, how much it holds, and the last save. */
  function info() {
    const dir = dirOf();
    if (!dir) return { available: false, note: demo ? 'The demo saves nothing.' : 'Results are saved beside your config once there is one.' };
    const size = savedSize(dir, CHECKS_SUB);
    return { available: true, days: size.days, bytes: size.bytes, lastSavedAt: state.savedAt, error: state.error };
  }

  /** "Forget saved results": the whole folder, deleted. */
  function forget() {
    const dir = dirOf();
    if (!dir) return { status: 409, body: { message: 'There are no saved results here to forget.' } };
    try {
      const r = forgetSaved(dir);
      state.savedAt = null;
      state.days = 0;
      state.forgotAt = now();
      const again = savedOptions(config()) ? ' Saving is still on, so the next window that loads is saved again.' : '';
      return { status: 200, body: { forgotten: r.forgotten, message: `${r.forgotten ? 'Saved results deleted.' : 'There were no saved results to delete.'}${again}` } };
    } catch (err) {
      return { status: 500, body: { message: `The saved results couldn't all be deleted${err?.code ? ` (${err.code})` : ''}. Close anything using the folder and try again.` } };
    }
  }

  return { onChecked, load, info, forget };
}
