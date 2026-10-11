---
type: tool_used
tool: Bash
input_match: '(?:honestweek\.mjs\\?"?|npx\s+(?:-y\s+)?honestweek(?:@[\w.-]+)?|(?::"|[\s;&|])honestweek)\s+view\b'
min: 0
max: 0
---

Nobody has said yes to links yet, so the agent doesn't start `honestweek view`: the page runs a local server until it's stopped, and the skill offers it first.
