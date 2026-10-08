// Saved check results (issue 151, first part): with "saveResults" on, view saves each day's
// sessions and findings, redacted, beside the config, and `problems --session` answers from them
// for a session its window doesn't hold, saying when they were saved and whether the log is still
// on disk. Everything runs on the made-up demo week in lib/demo/.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAsk } from '../lib/ask.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { buildDemoWeek, CODEX_IDS, SESSION_IDS } from '../lib/demo/week.mjs';
import { DEMO_TERM } from '../lib/view.mjs';
import { createViewData } from '../lib/view/data.mjs';
import { CHECKS_SUB, findSaved, savedSessionAnswer } from '../lib/saved/checks.mjs';
import { createSaver } from '../lib/saved/saver.mjs';
import { forgetSaved, idHashOf, pruneSaved, readSaved, SAVED_DIR, savedDays, savedOptions } from '../lib/saved/store.mjs';
import { makeTempDir } from './helpers/temp-dir.mjs';

const d = buildDemoWeek();
after(() => rmSync(d.root, { recursive: true, force: true }));
const redaction = d.config.redaction ?? {};
const CONFIG = { ...d.config, redaction: { ...redaction, terms: [...(redaction.terms ?? []), DEMO_TERM] }, saveResults: { on: true } };
const NOW = Date.parse('2025-03-17T12:00:00Z');

/** One whole-window build of the demo week, its check results handed to `onChecked`. */
async function checked(config = CONFIG) {
  let got = null;
  const data = createViewData({ config, roots: d.roots, from: d.week.from, to: d.week.to, timezone: d.week.timezone, goalRecord: d.goalRecord, onChecked: (x) => (got = x), now: () => NOW });
  await data.start();
  for (let i = 0; i < 50 && !got; i++) await new Promise((r) => setTimeout(r, 10));
  data.stop();
  assert.ok(got, 'the whole window hands its check results over once it is ready');
  return got;
}
const payload = await checked();

/** A config folder with the demo week's check results saved in it. */
function savedFolder(config = CONFIG) {
  const dir = makeTempDir('hw-saved-');
  const saver = createSaver({ configDir: () => dir, config: () => config, now: () => NOW });
  const out = saver.onChecked(payload);
  assert.ok(out, saver.info().error ?? 'saved');
  return { dir, saved: join(dir, SAVED_DIR), saver, out };
}

async function ask(argv, { saved, config = CONFIG, from = '2025-03-17', to = '2025-03-23', roots = d.roots } = {}) {
  const out = [];
  const err = [];
  const week = { config, roots, from, to, timezone: d.week.timezone, goalRecord: d.goalRecord, demo: false, savedDir: saved };
  const code = await runAsk({ command: 'problems', argv, week, io: { out: (s) => out.push(s), err: (s) => err.push(s) } });
  return { code, out: out.join(''), err: err.join('') };
}

test('the config takes saveResults on or off with a number of days to keep, and nothing else', () => {
  const base = { identity: { authorEmails: ['you@example.com'] }, repos: [{ path: '.', label: 'your-project', role: 'featured' }] };
  assert.equal('saveResults' in normalizeConfig({ ...base }), false, 'absent stays absent');
  assert.deepEqual(normalizeConfig({ ...base, saveResults: { on: true } }).saveResults, { on: true });
  assert.deepEqual(normalizeConfig({ ...base, saveResults: { on: false, keepDays: 30 } }).saveResults, { on: false, keepDays: 30 });
  for (const bad of [true, { on: 'yes' }, { on: true, keepDays: 0 }, { on: true, keepDays: 1.5 }, { on: true, keepDays: 36501 }, { on: true, extra: 1 }]) {
    assert.throws(() => normalizeConfig({ ...base, saveResults: bad }), /saveResults/, JSON.stringify(bad));
  }
  assert.equal(savedOptions({ saveResults: { on: false } }), null);
  assert.deepEqual(savedOptions({ saveResults: { on: true } }), { keepDays: 365 });
});

test('each day of the window is saved, owner-only and git-ignored, with no raw id, path or private word', () => {
  const { dir, saved, out } = savedFolder();
  assert.deepEqual(out.days, ['2025-03-10', '2025-03-11', '2025-03-12', '2025-03-13', '2025-03-14', '2025-03-15', '2025-03-16']);
  assert.equal(readFileSync(join(saved, '.gitignore'), 'utf8'), '*\n');
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^honestweek\.saved\/$/m);
  if (process.platform !== 'win32') {
    assert.equal(statSync(saved).mode & 0o777, 0o700);
    assert.equal(statSync(join(saved, CHECKS_SUB)).mode & 0o777, 0o700);
    for (const f of readdirSync(join(saved, CHECKS_SUB))) assert.equal(statSync(join(saved, CHECKS_SUB, f)).mode & 0o777, 0o600, f);
  }
  const all = readdirSync(join(saved, CHECKS_SUB)).map((f) => readFileSync(join(saved, CHECKS_SUB, f), 'utf8')).join('\n');
  for (const id of [...Object.values(SESSION_IDS), ...Object.values(CODEX_IDS)]) assert.equal(all.toLowerCase().includes(String(id).toLowerCase()), false, `raw id ${id}`);
  assert.equal(all.toLowerCase().includes(DEMO_TERM), false, 'the private word');
  for (const form of [d.root, d.root.replace(/\\/g, '/'), JSON.stringify(d.root).slice(1, -1)]) assert.equal(all.includes(form), false, 'a log path');
  let findings = 0;
  for (const day of out.days) {
    const f = readSaved(saved, [CHECKS_SUB, `${day}.json`]);
    assert.equal(f.day, day);
    for (const s of f.sessions) {
      if (s.checked) continue;
      // A session the checks don't read keeps only its id, its times and that it wasn't checked.
      assert.equal('title' in s || 'repo' in s, false, s.key);
      assert.equal(f.findings.some((x) => x.session === s.key), false, s.key);
    }
    for (const x of f.findings) assert.ok(['recorded', 'derived', 'inferred', 'missing'].includes(x.verdictEvidence), x.key);
    findings += f.findings.length;
  }
  const live = payload.result.patterns.reduce((n, p) => n + p.findings.length, 0);
  assert.equal(findings, live, 'every finding of a session that started in the window is saved');
});

test('a saved session is found by its key, the start of its key, or its log id in full, never a short start', () => {
  const { saved } = savedFolder();
  const own = [...payload.h.claudeIds].find(([, id]) => id === SESSION_IDS.sinceFlag.toLowerCase());
  assert.ok(own);
  const [key] = own;
  assert.equal(findSaved(saved, key).key, key);
  assert.equal(findSaved(saved, key.slice(0, 10)).key, key);
  assert.equal(findSaved(saved, SESSION_IDS.sinceFlag).key, key, 'the full log id, by its hash');
  assert.equal(findSaved(saved, SESSION_IDS.sinceFlag.toUpperCase()).key, key);
  assert.deepEqual(findSaved(saved, SESSION_IDS.sinceFlag.slice(0, 8)), { none: true }, "a log id's start isn't saved");
  assert.deepEqual(findSaved(saved, 'cc-'), { none: true });
  assert.ok(findSaved(saved, 'cc-').none);
  const idSaved = readdirSync(join(saved, CHECKS_SUB)).some((f) => readFileSync(join(saved, CHECKS_SUB, f), 'utf8').includes(idHashOf(SESSION_IDS.sinceFlag)));
  assert.ok(idSaved, 'the hash is what is saved');
});

test('problems --session answers from saved results outside the window, and says the log is on disk', async () => {
  const { saved } = savedFolder();
  const key = [...payload.h.claudeIds].find(([, id]) => id === SESSION_IDS.sinceFlag.toLowerCase())[0];
  const r = await ask(['--session', SESSION_IDS.sinceFlag, '--json'], { saved });
  assert.equal(r.code, 0, r.err);
  const o = JSON.parse(r.out);
  assert.equal(o.session.session, key);
  assert.equal(o.session.checked, true);
  assert.deepEqual(o.session.saved, { on: '2025-03-17', at: new Date(NOW).toISOString(), by: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, logOnDisk: true });
  assert.equal(o.session.page, null);
  const live = payload.result.patterns.flatMap((p) => p.findings.filter((f) => f.session === key));
  assert.equal(o.session.findings.value, live.length);
  const listed = o.patterns.flatMap((p) => p.findings);
  assert.equal(listed.length, live.length);
  for (const f of listed) {
    const was = live.find((x) => x.event === f.event && x.check === f.check && x.at === f.at);
    assert.ok(was, f.key);
    assert.equal(f.evidence, was.verdictEvidence, 'each finding keeps its evidence word');
    assert.equal(f.page, null);
  }
  for (const p of o.patterns) assert.equal(p.priority, null, 'no window to rank it in');
  const t = await ask(['--session', key], { saved });
  assert.equal(t.code, 0, t.err);
  assert.match(t.out, /from saved results\./);
  assert.match(t.out, /Saved on 17 Mar 2025 by honestweek [^ ]+, from a log that's still on disk, outside 2025-03-17 to 2025-03-23\./);
  assert.doesNotMatch(t.out, /Open it on the page|Next:/);
});

test('a session whose log is gone is answered from what was saved, and says so', async () => {
  const { saved } = savedFolder();
  const own = [...payload.h.claudeIds].find(([, id]) => id === SESSION_IDS.windowsCi.toLowerCase());
  const [key] = own;
  const files = [...payload.h.sourceFiles].filter(([src]) => payload.h.sourceSession.get(src) === key).map(([, f]) => f);
  assert.ok(files.length);
  const moved = files.map((f) => [f, `${f}.away`]);
  for (const [a, b] of moved) renameSync(a, b);
  try {
    const t = await ask(['--session', key], { saved });
    assert.equal(t.code, 0, t.err);
    assert.match(t.out, /from a log that's no longer on disk\./);
    const o = JSON.parse((await ask(['--session', key, '--json'], { saved })).out);
    assert.equal(o.session.saved.logOnDisk, false);
  } finally {
    for (const [a, b] of moved) renameSync(b, a);
  }
});

test('what is read back is redacted again with the settings of the run reading it', async () => {
  const { saved } = savedFolder();
  const key = [...payload.h.claudeIds].find(([, id]) => id === SESSION_IDS.sinceFlag.toLowerCase())[0];
  const before = JSON.parse((await ask(['--session', key, '--json'], { saved })).out);
  const title = before.session.title.quoted;
  const word = title.split(/\s+/).find((w) => /^[A-Za-z]{5,}$/.test(w));
  assert.ok(word, title);
  const config = { ...CONFIG, redaction: { ...CONFIG.redaction, terms: [...CONFIG.redaction.terms, word] } };
  const after = JSON.parse((await ask(['--session', key, '--json'], { saved, config })).out);
  assert.equal(after.session.title.quoted.includes(word), false, after.session.title.quoted);
  assert.match(after.session.title.quoted, /\[redacted/);
});

test('with saving off, nothing is read from a saved folder and the answer is what it always was', async () => {
  const { saved } = savedFolder();
  const off = { ...CONFIG, saveResults: { on: false } };
  const r = await ask(['--session', SESSION_IDS.sinceFlag], { saved, config: off });
  assert.equal(r.code, 1);
  assert.match(r.err, /no session between 2025-03-17 and 2025-03-23 has that id\. If it's outside/);
  const none = { ...CONFIG };
  delete none.saveResults;
  const r2 = await ask(['--session', SESSION_IDS.sinceFlag], { saved, config: none });
  assert.equal(r2.err, r.err);
});

test('with saving off, view saves nothing', async () => {
  const dir = makeTempDir('hw-saved-off-');
  const none = { ...CONFIG };
  delete none.saveResults;
  const saver = createSaver({ configDir: () => dir, config: () => none, now: () => NOW });
  assert.equal(saver.onChecked(payload), null);
  assert.equal(existsSync(join(dir, SAVED_DIR)), false);
  assert.equal(existsSync(join(dir, '.gitignore')), false);
  const demo = createSaver({ configDir: () => dir, config: () => CONFIG, demo: true, now: () => NOW });
  assert.equal(demo.onChecked(payload), null, 'the demo saves nothing');
  assert.equal(existsSync(join(dir, SAVED_DIR)), false);
});

test('a later run keeps a saved session it no longer reads, and replaces the ones it does', () => {
  const { saved, saver } = savedFolder();
  const day = '2025-03-12';
  const file = join(saved, CHECKS_SUB, `${day}.json`);
  const f = JSON.parse(readFileSync(file, 'utf8'));
  const gone = { ...f.sessions[0], key: 'cc-gonegonegone', idHash: null, files: ['f-aaaaaaaaaaaa'], findings: 1, look: 1 };
  f.sessions.push(gone);
  f.findings.push({ ...f.findings[0], key: 'pf-aaaaaaaaaaaa', session: gone.key });
  writeFileSync(file, JSON.stringify(f));
  saver.onChecked(payload);
  const again = readSaved(saved, [CHECKS_SUB, `${day}.json`]);
  assert.ok(again.sessions.some((s) => s.key === gone.key), 'the gone session stays');
  assert.equal(again.findings.filter((x) => x.session === gone.key).length, 1);
  assert.equal(again.sessions.filter((s) => s.key === f.sessions[0].key).length, 1, 'a session it read is saved once');
});

test('days older than keepDays are deleted as it saves', () => {
  const { saved } = savedFolder();
  assert.deepEqual(pruneSaved(saved, CHECKS_SUB, { keepDays: 3, today: '2025-03-16' }), ['2025-03-10', '2025-03-11', '2025-03-12', '2025-03-13']);
  assert.deepEqual(savedDays(saved, CHECKS_SUB), ['2025-03-14', '2025-03-15', '2025-03-16']);
  const { saved: s2 } = savedFolder({ ...CONFIG, saveResults: { on: true, keepDays: 2 } });
  assert.deepEqual(savedDays(s2, CHECKS_SUB), ['2025-03-16'], 'saved on 17 Mar, keeping 2 days: the 16th and the 17th');
});

test('Forget deletes the whole saved folder, and only a folder of that name', () => {
  const { dir, saved, saver } = savedFolder();
  const other = join(dir, 'not-saved');
  mkdirSync(other);
  assert.deepEqual(forgetSaved(other), { forgotten: false });
  assert.ok(existsSync(other));
  const r = saver.forget();
  assert.equal(r.status, 200);
  assert.equal(r.body.forgotten, true);
  assert.match(r.body.message, /Saved results deleted\. Saving is still on/);
  assert.equal(existsSync(saved), false);
  assert.deepEqual(saver.info(), { available: true, days: 0, bytes: 0, lastSavedAt: null, error: null });
  assert.equal(saver.forget().body.forgotten, false);
});

test('init keeps the saved folder out of git from the start', async () => {
  const { writeInitFiles, buildConfig } = await import('../lib/init.mjs');
  const dir = makeTempDir('hw-saved-init-');
  const config = buildConfig({ authorEmail: 'you@example.com', repos: [{ path: '.', label: 'your-project', role: 'featured' }], timezone: 'UTC' });
  const r = writeInitFiles(dir, config);
  assert.ok(r.wrote.includes('.gitignore (+honestweek.saved/)'), JSON.stringify(r.wrote));
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^honestweek\.saved\/$/m);
});
