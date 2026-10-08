---
type: tool_used
tool: Bash
input_match: 'honestweek(?:\.mjs)?\W{0,4}init\b'
min: 0
max: 0
---

With no config anywhere, the agent doesn't run `init` on its own, whether through the bundled script, `npx` or the installed command. The pattern runs over the command as JSON, where the quote after the script's path shows up as a backslash and a quote.
