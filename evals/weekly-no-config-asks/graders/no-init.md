---
type: tool_used
tool: Bash
input_match: '(?:honestweek\.mjs\\?"?|npx\s+(?:-y\s+)?honestweek(?:@[\w.-]+)?|(?::"|[\s;&|])honestweek)\s+init\b'
min: 0
max: 0
---

With no config anywhere, the agent doesn't run `init` on its own, whether through the bundled script, `npx` or the installed command. The pattern runs over the command as JSON, where the quote after the script's path shows up as a backslash and a quote. A command that only mentions init, such as a search of the docs for it, doesn't count.
