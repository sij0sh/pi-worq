# Option Matrix

**When to use:** Comparing 2–4 viable approaches against explicit constraints, reversibility, and effort so the user can choose cleanly.

## Core questions

1. What are the genuinely distinct options (including doing nothing / smallest change)?
2. Which 4–6 criteria actually separate the options (not generic filler)?
3. Where does each option clearly win, clearly lose, or fail a hard constraint?
4. Which option is easiest to reverse if an assumption proves wrong?
5. What recommendation follows, and what single assumption would flip it?

## Output structure

```markdown
# Option Matrix

## Decision criteria
- <Criterion>: <why it matters here>

## Comparison
| Criterion | Option A | Option B | Option C |
|---|---|---|---|
| ... | ... | ... | ... |

## Recommendation & flip condition
- **Recommended:** <option> — <1–2 sentence basis>
- **Would flip if:** <specific condition or user preference>
```

## Evidence rule

Tag every factual cell and constraint with `path:line`, `[Title](URL)`, or `assumed`. Mark estimates explicitly as `assumed`.

## Anti-patterns

- Including a strawman option just to make the preferred option look inevitable.
- Padding the table with criteria where every option scores identically.
- Hiding a hard disqualifier inside a soft prose cell instead of flagging it up front.
