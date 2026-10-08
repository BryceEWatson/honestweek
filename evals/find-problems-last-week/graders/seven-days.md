---
type: tool_used
tool: Bash
input_match: '\bproblems\b.*?--days[ =]7\b'
min: 1
---

"The last week" means the last 7 days: the agent asks `problems` with `--days 7`, not the config's own window, which can be longer and load only its newest days.
