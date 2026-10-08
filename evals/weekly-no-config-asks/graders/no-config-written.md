---
type: regex
target: files
pattern: honestweek\.config\.json
match: not_contains
---

No config gets written in the run's folder, by `init` or by hand, before the user says to. `target: files` is the list of files the run made, by path, so this catches one in a subfolder too.
