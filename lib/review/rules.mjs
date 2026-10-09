// lib/review/rules.mjs: the named rules behind every inferred row of the review brief.
//
// Like the engine's own rules (lib/replay/classify.mjs), an inferred row has to name one of
// these, so this file is the full list of ways the brief reads a log or git beyond what they
// say outright. Each one says what it reads and where. The ids start with `brief.`.

/** id -> plain description. The brief's JSON carries the descriptions of the rules it names. */
export const BRIEF_RULES = new Map([
  // The pull request's last commit (its head).
  ['brief.head-merge-parent', "The pull request landed as a merge commit (\"Merge pull request #N from ...\"), and its second parent is read as the pull request's last commit."],
  ['brief.head-last-push', "The pull request was squash-merged, so its branch's last commit is read as the last commit a session recorded before its last recorded push to the branch, before the landing."],
  ['brief.head-same-tree', "The pull request was squash-merged, and a commit a session recorded or printed (git's output, or gh's headRefOid) has exactly the files the squash commit landed, so it's read as the branch's last commit. The latest such commit wins."],
  ['brief.head-printed', "The last commit id gh printed as this pull request's headRefOid in a session."],
  ['brief.head-local-branch', "The pull request's last commit is read from this machine's copy of its branch (a local branch, else the origin remote-tracking one), which can be behind GitHub."],
  // The pull request's branch.
  ['brief.branch-push-before-create', 'The branch the last push a session made before it ran gh pr create for this pull request went to.'],
  ['brief.branch-head-option', "The --head option of the session's gh pr create command."],
  ['brief.branch-printed', 'The branch gh printed: "Creating pull request for <branch> into ..." from gh pr create, or headRefName from gh pr view.'],
  ['brief.branch-merge-subject', 'The branch a "Merge pull request #N from owner/branch" commit on the default branch names.'],
  ['brief.push-command', "A git push command's branch, read from the command line, for a push the harness didn't record (a Codex session, say)."],
  // The pull request's commits.
  ['brief.commit-before-push', 'A commit a session recorded before a push to the branch, with no other push between them, is read as one of the commits that push sent.'],
  // The issue it closes, and the ones it only names.
  ['brief.issue-closes', '"Closes", "Fixes" or "Resolves" (in any of their forms) and then #N, in the body of the recorded gh pr create command, a commit message in the range, or the landing commit\'s message.'],
  ['brief.issue-mentioned', 'An issue number named with no closing word before it (#N, owner/name#N, issue N): related to the pull request, never the one it closes.'],
]);

/** Where each rule reads: the session logs, git, or both. */
export const BRIEF_RULE_SOURCES = Object.freeze({
  'brief.head-merge-parent': 'git',
  'brief.head-last-push': 'logs and git',
  'brief.head-same-tree': 'logs and git',
  'brief.head-printed': 'logs',
  'brief.head-local-branch': 'git',
  'brief.branch-push-before-create': 'logs',
  'brief.branch-head-option': 'logs',
  'brief.branch-printed': 'logs',
  'brief.branch-merge-subject': 'git',
  'brief.push-command': 'logs',
  'brief.commit-before-push': 'logs and git',
  'brief.issue-closes': 'logs and git',
  'brief.issue-mentioned': 'logs and git',
});

/** The plain description of each brief rule named in `ids`, as { id: description }. */
export function describeBriefRules(ids) {
  const out = {};
  for (const id of [...new Set(ids)].filter(Boolean).sort()) out[id] = BRIEF_RULES.get(id) ?? null;
  return out;
}
