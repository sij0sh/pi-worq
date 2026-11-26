# Pre-Mortem

**When to use:** Stress-testing a leading option or high-risk commitment before locking it in, especially when reversal is costly.

## Core questions

1. Assume this choice shipped and failed painfully six months from now — what are the 3–5 most plausible root causes?
2. Which failure modes are silent (discovered late in production) vs loud (caught early in tests)?
3. What existing codebase invariant, operational limit, or external dependency is most likely to break first?
4. What cheap safeguard, tripwire, or staged rollout eliminates or detects each failure early?
5. Which residual risks remain unavoidable and must be accepted explicitly by the user?

## Output structure

```markdown
# Pre-Mortem: <Target Option>

## Failure scenarios
| # | Failure mode | Mechanism | Likelihood / Impact | Early tripwire or mitigation |
|---|---|---|---|---|
| 1 | ... | ... | ... | ... |

## Unavoidable residual risks
- <Risk> — <owner / explicit acceptance needed>

## Go / no-go safeguards
- <Concrete check or gate to require before committing>
```

## Evidence rule

Anchor each mechanism to observed code (`path:line`), documented external behavior (`[Title](URL)`), or mark it `assumed`.

## Anti-patterns

- Listing vague worries ("might not scale", "hard to maintain") without a concrete failure mechanism.
- Proposing heavyweight mitigations that cost more than the risk they prevent.
- Treating a fatal flaw as a minor footnote instead of revisiting the option.
