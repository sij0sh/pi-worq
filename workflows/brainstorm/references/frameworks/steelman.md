# Steelman

**When to use:** Evaluating a contested two-way tradeoff where premature consensus or confirmation bias could bury the strongest opposing argument.

## Core questions

1. What is the strongest, most charitable case for the leading approach?
2. What is the strongest, most charitable case for the leading counter-approach (written as its best advocate would argue it)?
3. On which underlying value, constraint, or prediction do the two sides actually disagree?
4. What concrete evidence (experiment, benchmark, or repo fact) would settle the disagreement?
5. Is there a hybrid or sequencing move that captures the upside of one without triggering the core objection of the other?

## Output structure

```markdown
# Steelman: <Position A> vs <Position B>

## Strongest case for <Position A>
- ...

## Strongest case for <Position B>
- ...

## The crux of disagreement
- <Exact assumption, constraint, or priority that separates them>

## What would settle it
- <Observable evidence or user preference>
```

## Evidence rule

Back factual premises with `path:line` or `[Title](URL)`; label value judgments and predictions explicitly as `assumed` or `user-owned`.

## Anti-patterns

- Weakening the opposing case into a caricature so the preferred side wins cheaply.
- Ending in "both have pros and cons" without naming the single crux that separates them.
- Conflating a factual uncertainty (testable) with a preference tradeoff (user-owned).
