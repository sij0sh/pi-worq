# Open Questions

**When to use:** Surfacing the small set of unresolved facts, risks, and user-owned decisions that genuinely block or steer the next step.

## Core questions

1. Which unknowns are **user-owned** (product intent, risk tolerance, budget, vendor/key choice) vs **discoverable** (codebase/benchmark facts)?
2. For each question, what concrete decision changes depending on the answer?
3. What is the safest provisional default if the user wants to move forward without settling it yet?
4. What is the cheapest next step (a quick `worq_send` follow-up, a `scout`, or a `plan`) to resolve each item?

## Output structure

```markdown
# Open Questions

## User-owned decisions
| # | Question | Options / implications | Provisional default |
|---|---|---|---|
| 1 | ... | ... | ... |

## Discoverable unknowns
| # | Question | Why it matters | Cheapest way to settle |
|---|---|---|---|
| 1 | ... | ... | ... |

## Suggested next moves
- <Concrete follow-up prompt for worq_send, or handoff to plan>
```

## Evidence rule

Cite why each unknown is unsettled (`path:line`, `[Title](URL)`, or `assumed`). Never list a question the repository already answers.

## Anti-patterns

- Dumping 15 low-impact questions that wouldn't change the decision either way.
- Asking the user questions that can be checked directly in the codebase.
- Omitting provisional defaults, forcing the user to answer trivia before progress can happen.
