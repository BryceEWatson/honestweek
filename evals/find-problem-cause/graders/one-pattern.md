---
type: tool_used
tool: Bash
input_match: '\bproblems\b(?=.*?--demo\b)(?=.*?--(?:pattern|finding)[ =])'
min: 1
---

The agent asks about the one pattern with `problems --pattern` (or one finding with `--finding`) on the demo week, rather than reading the whole list and guessing.
