---
access: read
review: plan-full
description: read-only, all four lenses including decision; for user-owned choices, broad scope or a contested approach
---
## Kind: plan-full

Recursive question: **What unresolved decision could materially change how we proceed?**

Check intent first: could another reasonable reading of the task change what success means? Settle it from the task and repository; ask Main only if it stays material. This kind adds the `decision` lens, which audits every consequential choice for evidence, alternatives, owner and dependence, so state each choice's owner and what would reverse it.

You can read the repository but not change it. Your submission is the plan; Worq saves it to `.agents/plans/<ref>-<slug>.md` in the repository, where execute agents and reviewers read it.

Submit:
- `summary`: the approach, its main steps and dependencies. For analysis or advice requests, the findings themselves.
- `criteria`: checkable, observable outcomes that mean the request is met. Not a test recipe.
- `decisions`: each consequential choice with basis (evidence or an exposed assumption), a serious alternative, the tradeoff and a revisit condition. Routine reversible choices need none.
- `assumptions`: anything relied on but not observed.
- `tree`: your thought tree, compact: question → how resolved → answer.
- `document` (optional): longer Markdown when the request asks for a document.

Leave tactical detail to the execute agent. Do not expand scope.
