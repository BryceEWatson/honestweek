---
type: tool_used
tool: Skill
input_match: '"skill"\s*:\s*"(?:[\w-]+:)?honestweek"'
min: 1
arm: both
---

The weekly skill starts for the request. `arm: both` keeps this scored: beside the case's other graders, a Skill check would otherwise only be reported, so the case could pass with the skill never starting.
